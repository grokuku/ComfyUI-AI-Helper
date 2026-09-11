# Copyright (C) Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# This program is free software: you can redistribute it and/or modify it
# under the terms of the GNU General Public License, version 3 or any later
# version. <https://www.gnu.org/licenses/>

"""aih — Socle backend partagé AIH (porté depuis AI-Helper/AIH_ComfyUI).

Ce sous-package héberge l'infrastructure partagée par les futures nodes et
routes ``/aih/*`` :

- ``store``            : store SQLite WAL local (miroirs + outbox + meta)
                         dans ``<ComfyUI>/user/default/aih/data/aihelper.db`` ;
- ``sync_engine``      : moteur de synchronisation avec le backend AIH distant
                         (URL configurée dans credentials.json ; manifest/export
                         paginé, outbox, thread périodique) ;
- ``embedding_engine`` : embeddings locaux (sentence-transformers ou Ollama) ;
- ``local_source``     : couche de lecture locale par-dessus le store ;
- ``credentials``      : lecture/écriture de ``user/default/aih/credentials.json``
                         (api_key + server_url, cache mémoire) ;
- ``llm_helper``       : appels LLM unifiés (LM Studio SDK, API compatible
                         OpenAI, Ollama ; vision multimodale incluse) ;
- ``music_prompts``    : system prompts & builders du pipeline Music 3.0
                         (miroir du backend AIH distant, consommé par la node
                         Music en mode local).

Le dossier ``templates/`` héberge les prompts maîtres de référence MiniMax
Music 3.0 (``minimax_music3_music_template.txt``,
``minimax_music3_lyrics_template.txt``) — matériel de référence rapatrié de la
racine du monorepo AI-Helper, non lu au runtime.

Importation : la racine du pack est ajoutée au ``sys.path`` par le
``__init__.py`` racine de l'extension (bootstrap unique — voir le bloc
« AIH shared backend package bootstrap »), car ComfyUI charge les packs
custom-nodes SANS ajouter leur dossier au sys.path. Tous les modules
s'importent donc en absolu : ``from aih import store``. Un seul exemplaire
de chaque module existe ainsi dans tout le pack.

Aucun module de ce package ne déclare de node ComfyUI et aucun thread/route
n'est démarré à l'import : c'est le rôle des consommateurs (chantiers B/C du
PLAN_FUSION.md).

Chemins de données : conservés À L'IDENTIQUE de l'extension AI-Helper
d'origine (``user/default/aih/``) afin de ne pas perdre les données existantes
des utilisateurs (aihelper.db, credentials.json, presets, clés OpenAI...).
Ce répertoire cohabite avec ``user/default/AI-Helper/``, racine des
sous-systèmes Holaf (cf. ``holaf_user_data_manager.UserDataManager.ROOT_NAME``)
: noms distincts, aucune collision même sur filesystem insensible à la casse ;
une unification éventuelle est différée (voir PLAN_FUSION.md §3.9).
"""

__all__ = [
    "store",
    "sync_engine",
    "embedding_engine",
    "local_source",
    "credentials",
    "llm_helper",
    "music_prompts",
]
