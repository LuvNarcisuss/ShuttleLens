from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, HttpUrl

OnboardingStatus = Literal["phone_pending", "profile_pending", "active"]
RequiredStep = Literal["bind_phone", "complete_profile"]


class WechatLoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    login_code: str = Field(min_length=1, max_length=1024)


class WechatPhoneRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    phone_code: str = Field(min_length=1, max_length=1024)


class ProfileUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    nickname: str = Field(min_length=1, max_length=64)
    avatar_url: HttpUrl


class PasswordSetRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    password: str = Field(min_length=8, max_length=128)


class AccountLoginRequest(PasswordSetRequest):
    account_number: str = Field(min_length=8, max_length=8, pattern=r"\d{8}")


class UserResponse(BaseModel):
    id: UUID
    account_number: str
    nickname: str | None
    avatar_url: HttpUrl | None
    masked_phone: str | None
    onboarding_status: OnboardingStatus
    password_set: bool
    wechat_bound: bool = True


class CurrentUserResponse(UserResponse):
    required_steps: list[RequiredStep]


class AvatarUploadResponse(BaseModel):
    avatar_url: HttpUrl


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    user: UserResponse
    required_steps: list[RequiredStep]


class DeactivateResponse(BaseModel):
    status: Literal["deactivated"]
