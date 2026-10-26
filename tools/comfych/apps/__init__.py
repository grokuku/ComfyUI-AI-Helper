"""Comfy-Modal Gateway — Applications package.

Contains the central ``all_in_one`` module which wires together all GPU
workers (L4, L40S, A100, H100) under a single ``modal.App`` with a public
FastAPI router protected by API-key authentication.
"""
