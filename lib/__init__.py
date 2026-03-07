"""Legacy compatibility imports.

New reusable code belongs in ``pyforge/``. ``lib`` remains only so older local
imports keep working while the repo standardizes on the package namespace.
"""

from pyforge import emltpl_to_oft

__all__ = ["emltpl_to_oft"]
