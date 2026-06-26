"""Lightweight assertions that README.md and .env.example stay in sync with
app/send.py's config-resolution contract."""

from pathlib import Path

ROOT = Path(__file__).parent.parent
README = ROOT / "README.md"
ENV_EXAMPLE = ROOT / ".env.example"


def _readme() -> str:
    return README.read_text()


def _env_example() -> str:
    return ENV_EXAMPLE.read_text()


class TestReadmePhase6:
    def test_phase6_heading_present(self):
        assert "Phase 6" in _readme()

    def test_invocation_documented(self):
        assert "uv run python -m app.send" in _readme()

    def test_dry_run_flag_documented(self):
        assert "--dry-run" in _readme()

    def test_digest_id_flag_documented(self):
        assert "--digest-id" in _readme()

    def test_user_flag_documented(self):
        assert "--user" in _readme()

    def test_kin_digest_to_documented(self):
        assert "KIN_DIGEST_TO" in _readme()

    def test_gmail_address_fallback_documented(self):
        assert "GMAIL_ADDRESS" in _readme()

    def test_smtp_host_default_documented(self):
        assert "smtp.gmail.com" in _readme()

    def test_smtp_port_default_documented(self):
        assert "587" in _readme()


class TestEnvExamplePhase6:
    def test_kin_digest_to_present(self):
        assert "KIN_DIGEST_TO" in _env_example()

    def test_smtp_host_present(self):
        assert "SMTP_HOST" in _env_example()

    def test_smtp_port_present(self):
        assert "SMTP_PORT" in _env_example()
