"""Mint a short-lived Gmail access token from a stored refresh token."""
import google.auth.exceptions
import google.oauth2.credentials
from google.auth.transport.requests import Request


class ReauthRequired(Exception):
    """Raised when the refresh token has been revoked or has expired."""


def mint_access_credentials(
    *,
    refresh_token: str,
    client_id: str,
    client_secret: str,
) -> google.oauth2.credentials.Credentials:
    """Return refreshed Credentials for the Gmail API.

    Raises ReauthRequired if google-auth signals the refresh token is no
    longer valid (revoked by user or expired).
    """
    creds = google.oauth2.credentials.Credentials(
        token=None,
        refresh_token=refresh_token,
        token_uri="https://oauth2.googleapis.com/token",
        client_id=client_id,
        client_secret=client_secret,
    )
    try:
        creds.refresh(Request())
    except google.auth.exceptions.RefreshError as exc:
        raise ReauthRequired(str(exc)) from exc
    return creds
