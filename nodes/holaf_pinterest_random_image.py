# Copyright (C) 2025 Holaf
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program. If not, see <https://www.gnu.org/licenses/>.

"""AIH Pinterest Random Image node.

Fetches a random image from Pinterest's public search page for a given theme
and returns it as a ComfyUI IMAGE tensor plus the source URL as a STRING.

FRAGILITY WARNING
-----------------
This node scrapes Pinterest's public HTML. Pinterest is a closed platform with
aggressive anti-bot measures (Cloudflare, rate limiting, A/B testing, changing
DOM/JSON structures). This scraping is inherently fragile and may break at any
time without notice. It is provided for convenience only; it does NOT bypass
any authentication, login wall or paywall, and it does not circumvent any
technical protection measure. Use it responsibly and respect Pinterest's
Terms of Service and the copyright of the images you retrieve.

The node tries three extraction strategies in order:
  1. Pinterest's internal ``SearchResource`` endpoint (primary, richest: it
     returns ~50 pins with their image URLs in one call).
  2. The ``__PWS_DATA__`` JSON blob embedded in the search page (fallback).
  3. A plain regex over the raw HTML (last-resort, best-effort).

If Pinterest blocks the request (HTTP 403/429) or changes its structure so no
image URL can be found, a clear ``ValueError`` is raised so the failure is
visible in the ComfyUI console instead of silently producing garbage.

ANTI-DUPLICATE (random mode only)
---------------------------------
In RANDOM mode (``seed == 0``) the node keeps an in-memory, per-theme history
of the URLs already picked and avoids re-picking them while the current pool
still has unseen URLs. This history is bounded to the 50 most recent picks per
theme and is reset automatically when the whole current pool has been covered.
It lives only in RAM, so it is lost when ComfyUI restarts. When ``seed != 0``
this memory is completely ignored so reproducibility stays strict (same seed ->
same image).
"""

import os
import re
import json
import random
import threading
import logging
import hashlib
import urllib.parse
import io

import requests
import folder_paths
from PIL import Image
from PIL import UnidentifiedImageError

# --- Shared-module bootstrap -------------------------------------------------
# Nodes in this pack are loaded one-file-at-a-time by the extension's dynamic
# loader (importlib.util.spec_from_file_location), which registers each file
# under a synthetic "<package>.nodes.<stem>" name WITHOUT importing any parent
# package: package-relative imports therefore cannot work here. Instead we put
# this directory on sys.path and import the shared modules absolutely, so every
# node resolves the SAME module instance (one ANY_TYPE singleton pack-wide).
# ``holaf_utils`` lives at the pack root, so we also add the parent directory.
import os as _os
import sys as _sys

_NODE_DIR = _os.path.dirname(_os.path.abspath(__file__))
if _NODE_DIR not in _sys.path:
    _sys.path.insert(0, _NODE_DIR)

_PACK_ROOT = _os.path.dirname(_NODE_DIR)
if _PACK_ROOT not in _sys.path:
    _sys.path.insert(0, _PACK_ROOT)

from holaf_node_helpers import pil_to_tensor  # noqa: E402  (requires _NODE_DIR above)
from holaf_utils import sanitize_filename  # noqa: E402  (requires _PACK_ROOT above)

logger = logging.getLogger("Holaf.PinterestRandomImage")

# --- Anti-duplicate memory (random mode only) --------------------------------
# In-memory, per-theme history of the URLs already picked in RANDOM mode
# (``seed == 0``). It is used to avoid returning the same image twice in a row
# while the current pool still has unseen URLs. It is bounded to the 50 most
# recent picks per theme and is reset automatically when the pool is exhausted.
# This memory lives only in RAM: it is lost when ComfyUI restarts, and it is
# completely ignored when ``seed != 0`` so reproducibility stays strict.
_RECENT_PICKS: dict[str, list[str]] = {}
_RECENT_LOCK = threading.Lock()

#: Maximum number of remembered picks per theme (most recent kept).
_RECENT_MAX = 50

# --- Constants ---------------------------------------------------------------
_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
_TIMEOUT = 15
_SEARCH_URL = "https://www.pinterest.com/search/pins/"
_SEARCH_RESOURCE_URL = "https://www.pinterest.com/resource/SearchResource/get/"

#: Ordered size-preference buckets for :func:`_rank_urls`. Pinterest CDN URLs
#: embed a size token in the path (e.g. ``/originals/``, ``/736x/``, ...).
_SIZE_PREFERENCE = ("originals/", "736x/", "474x/", "236x/")


# --- Module-level parsing helpers (unit-testable without network) ------------
def _extract_pws_data(html):
    """Extract and parse the ``__PWS_DATA__`` JSON blob from a Pinterest page.

    Returns the parsed dict, or ``None`` if the blob is absent or unparseable.
    """
    if not html:
        return None
    match = re.search(
        r'<script id="__PWS_DATA__" type="application/json">(.*?)</script>',
        html,
        flags=re.DOTALL,
    )
    if not match:
        return None
    try:
        return json.loads(match.group(1))
    except (json.JSONDecodeError, ValueError):
        return None


def _collect_pinimg_urls(data):
    """Recursively walk a parsed JSON structure collecting ``i.pinimg.com`` URLs.

    Query strings are stripped, results are de-duplicated, and a list is
    returned. Non-dict/list values are ignored.
    """
    found = set()

    def _walk(node):
        if isinstance(node, dict):
            for value in node.values():
                _walk(value)
        elif isinstance(node, list):
            for item in node:
                _walk(item)
        elif isinstance(node, str) and "i.pinimg.com" in node:
            # Strip any query string (e.g. "?x=...&y=...") before storing.
            clean = node.split("?", 1)[0]
            if clean:
                found.add(clean)

    _walk(data)
    return list(found)


def _extract_urls_regex(html):
    """Fallback: extract ``i.pinimg.com`` image URLs from raw HTML via regex.

    Query strings are stripped and results are de-duplicated.
    """
    if not html:
        return []
    pattern = re.compile(r"https://i\.pinimg\.com/[^\"'\s\\]+\.(?:jpg|jpeg|png|webp)")
    found = set()
    for match in pattern.findall(html):
        clean = match.split("?", 1)[0]
        if clean:
            found.add(clean)
    return list(found)


def _rank_urls(urls):
    """Sort URLs by size preference (stable): originals > 736x > 474x > 236x > other.

    The sort is stable, so URLs within the same bucket keep their original
    relative order. URLs that match no known bucket are ranked last.
    """
    def _bucket(url):
        for i, token in enumerate(_SIZE_PREFERENCE):
            if token in url:
                return i
        return len(_SIZE_PREFERENCE)

    return sorted(urls, key=_bucket)


def _fetch_search_page(theme):
    """GET the Pinterest search page for ``theme`` and return the HTML text."""
    params = {"q": theme}
    headers = {"User-Agent": _USER_AGENT}
    try:
        with requests.get(_SEARCH_URL, params=params, headers=headers, timeout=_TIMEOUT) as resp:
            if resp.status_code in (403, 429):
                raise ValueError(
                    f"Pinterest a bloqué la requête (HTTP {resp.status_code}). "
                    "Anti-bot / rate-limit actif. Réessayez plus tard ou changez de thème."
                )
            if resp.status_code != 200:
                raise ValueError(
                    f"Pinterest a répondu avec un statut inattendu (HTTP {resp.status_code})."
                )
            return resp.text
    except requests.RequestException as exc:
        raise ValueError(f"Erreur réseau lors de la requête Pinterest : {exc}") from exc


def _fetch_search_resource(theme):
    """POST to Pinterest's internal ``SearchResource`` endpoint for ``theme``.

    Returns the parsed JSON dict, or ``None`` if the request was blocked or the
    response could not be parsed. This endpoint returns a rich list of pins
    (with image URLs) and is the primary extraction strategy.

    It performs at most two requests: a GET of the search page (to obtain the
    CSRF cookie required by the endpoint) followed by the POST itself.
    """
    try:
        with requests.Session() as session:
            session.headers.update({"User-Agent": _USER_AGENT})

            # 1. Visit the search page to obtain the CSRF cookie.
            page = session.get(_SEARCH_URL, params={"q": theme}, timeout=_TIMEOUT)
            if page.status_code in (403, 429):
                page.close()
                return None
            csrf = session.cookies.get("csrftoken")
            if not csrf:
                page.close()
                return None

            # 2. POST to the SearchResource endpoint.
            quoted = urllib.parse.quote(theme)
            payload = {
                "options": {"query": theme, "scope": "pins", "page_size": 50},
                "context": {},
            }
            headers = {
                "Referer": f"{_SEARCH_URL}?q={quoted}",
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "X-Requested-With": "XMLHttpRequest",
                "Accept": "application/json, text/javascript, */*; q=0.01",
                "X-CSRFToken": csrf,
            }
            resp = session.post(
                _SEARCH_RESOURCE_URL,
                data={
                    "source_url": f"/search/pins/?q={quoted}",
                    "data": json.dumps(payload),
                },
                headers=headers,
                timeout=_TIMEOUT,
            )
            if resp.status_code != 200:
                return None
            return json.loads(resp.text)
    except (requests.RequestException, json.JSONDecodeError, ValueError):
        return None


def _extract_pin_urls_from_resource(data):
    """Extract one high-resolution image URL per pin from a SearchResource response.

    Each pin carries an ``images`` dict with several size buckets; we keep the
    largest (``orig``) URL so the random pick spans distinct images rather than
    multiple thumbnails of the same pin. Returns a de-duplicated list.
    """
    found = set()
    try:
        results = data["resource_response"]["data"]
    except (KeyError, TypeError):
        return []
    if not isinstance(results, list):
        return []

    for pin in results:
        if not isinstance(pin, dict):
            continue
        images = pin.get("images")
        if not isinstance(images, dict):
            continue

        # Prefer the original-size bucket, then the largest available size.
        url = None
        orig = images.get("orig")
        if isinstance(orig, dict) and orig.get("url"):
            url = orig["url"]
        if not url:
            best = None
            for bucket in images.values():
                if not isinstance(bucket, dict):
                    continue
                bucket_url = bucket.get("url")
                if not isinstance(bucket_url, str):
                    continue
                width = bucket.get("width")
                if not isinstance(width, (int, float)):
                    width = 0
                if best is None or width > best[0]:
                    best = (width, bucket_url)
            if best:
                url = best[1]

        if isinstance(url, str) and "i.pinimg.com" in url:
            found.add(url.split("?", 1)[0])
    return list(found)


def _collect_image_urls(theme):
    """Collect candidate image URLs for ``theme`` using a cascade of strategies.

    Strategy order:
      1. Pinterest's internal ``SearchResource`` endpoint (rich, ~50 pins).
      2. ``__PWS_DATA__`` JSON blob embedded in the search page.
      3. Plain regex over the raw HTML (last resort).

    Returns a de-duplicated list of ``i.pinimg.com`` URLs (best-effort).
    """
    # 1. Primary: SearchResource endpoint (2 requests max).
    resource = _fetch_search_resource(theme)
    if resource is not None:
        urls = _extract_pin_urls_from_resource(resource)
        if urls:
            return urls

    # 2. Fallback: parse the search page HTML.
    page = _fetch_search_page(theme)
    data = _extract_pws_data(page)
    if data is not None:
        urls = _collect_pinimg_urls(data)
        if urls:
            return urls

    # 3. Last resort: regex over the raw HTML.
    return _extract_urls_regex(page)


def _download_image(url):
    """Download the image bytes at ``url`` and return ``response.content``."""
    headers = {"User-Agent": _USER_AGENT}
    try:
        with requests.get(url, headers=headers, timeout=_TIMEOUT) as resp:
            if resp.status_code in (403, 429):
                raise ValueError(
                    f"Pinterest a bloqué le téléchargement de l'image (HTTP {resp.status_code})."
                )
            if resp.status_code != 200:
                raise ValueError(
                    f"Téléchargement de l'image échoué (HTTP {resp.status_code})."
                )
            return resp.content
    except requests.RequestException as exc:
        raise ValueError(f"Erreur réseau lors du téléchargement de l'image : {exc}") from exc


class HolafPinterestRandomImage:
    """Fetch a random image from Pinterest for a given theme.

    - ``seed == 0``  -> a random seed is drawn each run (non-reproducible).
      In this mode an in-memory anti-duplicate history (per theme, bounded to
      the 50 most recent picks, reset when the pool is exhausted, lost on
      ComfyUI restart) avoids re-picking the same image while the current pool
      still has unseen URLs.
    - ``seed != 0``  -> the same seed always picks the same image for the same
      search results (reproducible, as long as Pinterest returns the same set).
      The anti-duplicate memory is IGNORED in this mode so reproducibility
      stays strict.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "theme": ("STRING", {"default": "robot", "multiline": False}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFF}),
                "save_to_input": ("BOOLEAN", {"default": True}),
            },
        }

    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("image", "source_url")
    FUNCTION = "load_random_image"
    CATEGORY = "AIH/IO"

    def load_random_image(self, theme, seed, save_to_input):
        """Load a random Pinterest image for ``theme``.

        In RANDOM mode (``seed == 0``) an in-memory anti-duplicate history
        (per theme, bounded to the 50 most recent picks, reset when the pool is
        exhausted, lost on ComfyUI restart) avoids re-picking the same image
        while the current pool still has unseen URLs. In REPRODUCIBLE mode
        (``seed != 0``) this memory is ignored so the same seed always yields
        the same image for the same search results.
        """
        # 1. Collect candidate image URLs (SearchResource first, HTML fallback).
        urls = _collect_image_urls(theme)

        # 2. Guard against empty results.
        if not urls:
            raise ValueError(
                f"Aucune image trouvée pour le thème '{theme}'. "
                "Pinterest peut avoir changé sa structure ou bloqué la requête."
            )

        # 3. Rank by size preference and pick one deterministically from the seed.
        urls = _rank_urls(urls)
        is_random = (seed == 0)
        if is_random:
            seed = random.randint(0, 2**31 - 1)
            # Anti-duplicate: avoid re-picking URLs already drawn for this theme
            # while the current pool still has unseen URLs.
            with _RECENT_LOCK:
                recent = _RECENT_PICKS.get(theme, [])
                recent_set = set(recent)
                candidates = [u for u in urls if u not in recent_set]
                if not candidates:
                    # Pool exhausted: reset the theme history and use the full pool.
                    _RECENT_PICKS[theme] = []
                    candidates = urls
                    logger.info(
                        f"Pool épuisé pour le thème '{theme}', "
                        "réinitialisation de l'historique anti-doublon"
                    )
        else:
            # Reproducible mode: ignore the anti-duplicate memory entirely.
            candidates = urls

        rng = random.Random(seed)
        url = candidates[rng.randrange(len(candidates))]

        if is_random:
            # Remember this pick (bounded to the 50 most recent per theme).
            with _RECENT_LOCK:
                recent = _RECENT_PICKS.get(theme, [])
                recent.append(url)
                if len(recent) > _RECENT_MAX:
                    recent = recent[-_RECENT_MAX:]
                _RECENT_PICKS[theme] = recent

        # 4. Download and decode the image.
        content = _download_image(url)
        try:
            img = Image.open(io.BytesIO(content))
            img = img.convert("RGB")  # pil_to_tensor already handles grayscale; be safe.
        except (UnidentifiedImageError, OSError) as exc:
            raise ValueError(f"L'image téléchargée n'est pas une image valide : {exc}") from exc

        # 5. Convert to a ComfyUI tensor (BHWC float32 [0,1]).
        tensor = pil_to_tensor(img)

        # 6. Optionally persist the image into ComfyUI's input directory.
        saved_path = None
        if save_to_input:
            try:
                slug = re.sub(r"[^a-z0-9]+", "_", theme.lower()).strip("_") or "pinterest"
                slug = slug[:48].strip("_") or "pinterest"
                url_hash = hashlib.md5(url.encode("utf-8")).hexdigest()[:8]
                ext = (img.format or "png").lower()
                if ext == "jpeg":
                    ext = "jpg"
                filename = sanitize_filename(f"pinterest_{slug}_{seed}_{url_hash}.{ext}")
                input_dir = folder_paths.get_input_directory()
                os.makedirs(input_dir, exist_ok=True)
                saved_path = os.path.join(input_dir, filename)
                img.save(saved_path)
            except Exception as exc:  # noqa: BLE001 - saving is best-effort
                logger.warning(f"Impossible de sauvegarder l'image Pinterest : {exc}")

        # 7. Log what happened.
        logger.info(f"Pinterest image source_url: {url}")
        if saved_path:
            logger.info(f"Pinterest image saved to: {saved_path}")

        img.close()
        return (tensor, url)


# === ComfyUI node registration =============================================
# Per-file registry read by the extension's dynamic loader. Canonical key
# follows the AIH naming convention (AIH<PascalCase>, no Node suffix).
# Legacy alias keys were removed (user decision): /api/object_info exposes
# one entry PER KEY, so a second alias key made every node appear TWICE in
# the Add Node search. Old workflows referencing the removed keys must be
# redone.
NODE_CLASS_MAPPINGS = {
    "AIHPinterestRandomImage": HolafPinterestRandomImage,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AIHPinterestRandomImage": "AIH Pinterest Random Image",
}
