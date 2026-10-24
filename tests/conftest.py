# ─────────────────────────────────────────────────────────────────────────
# conftest.py — garde anti-test de la migration des données utilisateur.
#
# POURQUOI (risque réel) : run_tests.sh importe les modules du pack par chemin
# absolu et plusieurs tests instancient des modules du pack. Le pack appelle
# holaf_user_paths.ensure_user_data_layout() à son démarrage (__init__.py) pour
# déplacer les données utilisateur hors de custom_nodes/ComfyUI-AI-Helper
# (base holaf_utilities.sqlite de 1,8 Go, config.ini, credentials…).
# Sans cette variable, lancer pytest depuis un poste de dev DÉPLACERAIT les
# vraies données de l'utilisateur.
#
# Double barrière, volontairement redondante :
#   1. AIH_SKIP_USER_MIGRATION=1 (aussi posée par run_tests.sh) ;
#   2. holaf_user_paths détecte PYTEST_CURRENT_TEST et l'absence de
#      folder_paths → il n'écrit jamais hors ComfyUI.
# Les tests de migration eux-mêmes passent force=True sur de FAUX arbres
# construits dans tmp_path : ils ne touchent à aucune donnée réelle.
# ─────────────────────────────────────────────────────────────────────────
import os

os.environ["AIH_SKIP_USER_MIGRATION"] = "1"
