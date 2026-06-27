"""Tests for ingest.oauth — token minting and ReauthRequired."""
from unittest.mock import MagicMock, patch

import google.auth.exceptions
import google.oauth2.credentials
import pytest

from ingest.oauth import ReauthRequired, mint_access_credentials


def test_mint_access_credentials_happy(monkeypatch):
    """mint_access_credentials calls Credentials.refresh and returns the creds."""
    refreshed = MagicMock(spec=google.oauth2.credentials.Credentials)

    with patch("ingest.oauth.Request") as mock_request_cls, \
         patch("ingest.oauth.google.oauth2.credentials.Credentials") as mock_creds_cls:
        mock_creds_cls.return_value = refreshed
        result = mint_access_credentials(
            refresh_token="rt",
            client_id="cid",
            client_secret="csec",
        )

    refreshed.refresh.assert_called_once_with(mock_request_cls.return_value)
    assert result is refreshed


def test_mint_access_credentials_raises_reauth_on_refresh_error():
    """When google-auth raises RefreshError, mint_access_credentials raises ReauthRequired."""
    with patch("ingest.oauth.Request"), \
         patch("ingest.oauth.google.oauth2.credentials.Credentials") as mock_creds_cls:
        fake_creds = MagicMock()
        fake_creds.refresh.side_effect = google.auth.exceptions.RefreshError("revoked")
        mock_creds_cls.return_value = fake_creds

        with pytest.raises(ReauthRequired):
            mint_access_credentials(
                refresh_token="bad_rt",
                client_id="cid",
                client_secret="csec",
            )


def test_reauth_required_is_not_refresh_error():
    """ReauthRequired must be our own exception type, not raw RefreshError."""
    assert not issubclass(ReauthRequired, google.auth.exceptions.RefreshError)
    assert issubclass(ReauthRequired, Exception)
