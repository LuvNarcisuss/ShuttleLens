from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from app.db.models.user import User
from app.schemas.auth import LoginResponse, UserResponse, WechatLoginRequest


def test_normalize_phone_keeps_country_code_separate_from_pure_phone() -> None:
    from app.services.user_onboarding import normalize_phone
    assert normalize_phone("86", "187 1234 2735") == "+8618712342735"
    assert normalize_phone("+1", "(415) 555-2671") == "+14155552671"


@pytest.mark.parametrize(("phone", "masked"), [("18712342735", "187****2735"), ("+8618712342735", "+86187****2735")])
def test_mask_phone_never_returns_the_complete_number(phone: str, masked: str) -> None:
    from app.services.user_onboarding import mask_phone
    assert mask_phone(phone) == masked
    assert phone not in masked


def test_onboarding_status_requires_phone_before_profile() -> None:
    from app.services.user_onboarding import get_onboarding_status
    user = User(openid="openid", account_number="10000006", nickname="test", avatar_url="https://example.com/a.jpg")
    assert get_onboarding_status(user) == "phone_pending"


def test_onboarding_status_is_active_only_when_phone_and_profile_are_complete() -> None:
    from app.services.user_onboarding import get_onboarding_status
    user = User(openid="openid", account_number="10000008", phone_verified_at=datetime.now(UTC), nickname="test", avatar_url="https://example.com/a.jpg")
    assert get_onboarding_status(user) == "active"


def test_login_response_serializes_safe_onboarding_fields_only() -> None:
    user = UserResponse(id="00000000-0000-0000-0000-000000000000", account_number="10000001", nickname="test", avatar_url="https://cdn.example.com/avatar.jpg", masked_phone="187****2735", onboarding_status="active", password_set=True)
    response = LoginResponse(access_token="jwt", expires_in=604800, user=user, required_steps=[])
    payload = response.model_dump(mode="json")
    assert payload["user"]["masked_phone"] == "187****2735"
    assert not {"openid", "session_key", "phone_number", "phone_number_encrypted", "phone_number_hash"} & payload["user"].keys()
