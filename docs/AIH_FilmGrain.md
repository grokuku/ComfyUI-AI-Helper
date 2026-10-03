# AIH Film Grain — grain de pellicule paramétrique

Node ComfyUI **`AIH Film Grain`** (clé `AIHFilmGrain`, catégorie `AIH/Image`) : ajoute un
grain de pellicule réaliste, **y compris sur de très grandes images**, sans ralentir quand
on affine le grain.

## Principe (pourquoi c'est rapide)

Réimplémentation *clean-room* du **modèle paramétrique de synthèse de grain AV1** (spec AV1
§7.18.3.3 ; idées des implémentations de référence dav1d / libaom, BSD-2-Clause — aucun code
copié) :

- un **gabarit de bruit ~64×64** est généré **une seule fois** par exécution : bruit blanc
  filtré par un modèle **autorégressif lag 0..3** qui fixe la taille du grain (coefficients
  Yule-Walker sur une covariance gaussienne, réponse impulsionnelle précalculée) ;
- chaque **bloc 32×32** de l'image prend un **crop aléatoire** de ce gabarit : le hasard ne
  tire que les **offsets de blocs** (un tirage pour ~1024 pixels, jamais un par pixel) ;
- la **réponse à la luminance** est une **LUT (512 bins)** indexée par la valeur du pixel
  (équivalent des « scaling points » AV1) ;
- **`grain_size` > 2 px** : le champ est généré à résolution réduite puis rééchantillonné
  bilinéairement — le coût par pixel reste **O(1), indépendant de la finesse** ;
- tout est **fp32**, *memory-bound* (quelques passes de gather), avec découpage optionnel en
  **tranches de lignes** pour plafonner la VRAM.

## Entrées

| Entrée | Défaut | Rôle |
|---|---|---|
| `image` | — | IMAGE `[B,H,W,C]` (0..1). Grain appliqué au **RGB uniquement**. |
| `model` | `Parametric (AV1)` | Modèle de grain. v1 : paramétrique seul. |
| `intensity` | `100` (0–200) | Force du grain. **0 ⇒ sortie bit-à-bit identique à l'entrée.** |
| `grain_size` | `1.2` (0.5–4 px) | Finesse (demi-largeur de corrélation). `> 2 px` ⇒ champ réduit + rééchantillonnage. |
| `response` | `Filmic` | `Neutral` (uniforme), `Filmic` (pic dans les tons moyens, atténuation ombres/hautes lumières), `Custom`. |
| `shadows_falloff` | `40` (0–100) | `Custom` : atténuation du grain dans les ombres ; 100 = grain nul dans les noirs. |
| `highlights_falloff` | `60` (0–100) | `Custom` : atténuation du grain dans les hautes lumières ; 100 = grain nul dans les blancs. |
| `chroma_grain` | `15` (0–100) | Part de grain **coloré** (Cb/Cr indépendants, convertis en RGB). `0` = grain **monochrome** (identique sur R, G, B). |
| `seed` | `0` | Reproductible, avec le widget `control_after_generate` du frontend. |
| `mask` *(option)* | — | MASK `[H,W]` ou `[B,H,W]` : module localement le grain. `0` = image intacte à cet endroit. |
| `animated` *(option)* | `false` | `false` = photo : **grain identique pour tout le batch**. `true` = vidéo : grain **stable par frame** et différent d'une frame à l'autre (seed + index). |
| `vram_rows` *(option)* | `0` (auto) | Traitement par tranches de lignes pour borner la VRAM. Le résultat est **bit-à-bit** celui d'un seul bloc. |

**Sortie** : `IMAGE`, même forme et même dtype que l'entrée (fp32), alpha préservé,
entrée jamais mutée.

## Garanties / contrôle de conformité

- `intensity = 0` ⇒ **copie bit-à-bit** de l'entrée (aucun tirage aléatoire n'est consommé) ;
- `mask = 0` ⇒ identité exacte ; un masque plein donne exactement le résultat sans masque ;
- `chroma_grain = 0` ⇒ le grain ajouté est identique sur R, G et B (monochrome) ;
- batch : `animated=false` ⇒ les frames reçoivent le **même** grain ; `animated=true` ⇒
  grain **par frame** (seed + index), reproductible à seed égale ;
- `vram_rows` ne change **jamais** le résultat (découpage interne transparent).

## Mesurer le temps d'exécution

Aucun réglage n'est nécessaire : la node est profilée automatiquement comme toutes les autres
par le **profiler générique du pack** (temps d'exécution par node). La node écrit en plus une
ligne unique dans la console à chaque exécution, par exemple :
`[AIH Film Grain] 3840x2160 px x1 — 12.3 ms`.

## Exemples de réglages

| Intention | Réglages |
|---|---|
| Argentique subtil (défaut) | `intensity 100`, `grain_size 1.2`, `response Filmic`, `chroma_grain 15` |
| Grain fin visible (16 mm) | `intensity 120–150`, `grain_size 0.8–1.0` |
| Gros grain (poussé, 800 ISO) | `intensity 130–180`, `grain_size 3–4` |
| N&B pur | `chroma_grain 0` |
| Vidéo | `animated = true` (le grain évolue frame par frame, seed + index) |
| Grain localisé | brancher un `mask` (0 = zones épargnées) |

## Notes

- Le mode **`Plate (scanned)`** (grain « scanné » non paramétrique) est prévu en v2 ;
  l'entrée `model` existe déjà pour pouvoir l'ajouter sans casser les workflows.
- Provenance : algorithme réécrit d'après la spécification AV1 et les idées des
  implémentations de référence (dav1d, libaom — BSD-2-Clause). Aucun code tiers n'est copié
  ni embarqué dans ce dépôt (voir `nodes/holaf_film_grain.py`, en-tête).
- Tests : `tests/test_film_grain.py` (skip propre sans torch via `pytest.importorskip`).
