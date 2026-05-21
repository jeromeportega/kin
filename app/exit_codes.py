"""Process exit codes shared across kin CLIs.

Centralized here so triage, digest, and any future command (audit, init, etc.)
agree on what a "config" or "DB" failure means without copy-pasting constants.
"""

EXIT_OK = 0
EXIT_UNEXPECTED = 1
EXIT_CONFIG = 2
EXIT_IMAP = 3
EXIT_MODEL = 4
EXIT_DB = 5
