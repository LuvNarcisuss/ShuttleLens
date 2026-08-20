import base64
import hashlib
import re
from datetime import UTC, datetime
from typing import Literal

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.db.models.user import User
from app.services.wechat_auth import WechatPhoneInfo

OnboardingStatus = Literal["phone_pending", "profile_pending", "active"]
RequiredStep = Literal["bind_phone", "complete_profile"]
_COUNTRY_CODE_PATTERN = re.compile(r"\+?([1-9]\d{0,3})")
_PURE_PHONE_PATTERN = re.compile(r"[0-9 ()-]+")


def normalize_phone(country_code: str, pure_phone: str) -> str:
    country_match = _COUNTRY_CODE_PATTERN.fullmatch(country_code.strip())
    if country_match is None or _PURE_PHONE_PATTERN.fullmatch(pure_phone.strip()) is None:
        raise ValueError("Invalid phone number")
    digits = "".join(character for character in pure_phone if character.isdigit())
    normalized = f"+{country_match.group(1)}{digits}"
    if len(digits) < 7 or len(normalized) > 16:
        raise ValueError("Invalid phone number")
    return normalized


def mask_phone(phone: str) -> str:
    value = phone.strip()
    if not re.fullmatch(r"\+?\d+", value) or len(value.removeprefix("+")) < 7:
        raise ValueError("Invalid phone number")
    return f"{value[:-8]}****{value[-4:]}"


def get_onboarding_status(user: User) -> OnboardingStatus:
    if user.phone_verified_at is None:
        return "phone_pending"
    if not (user.nickname or "").strip() or not (user.avatar_url or "").strip():
        return "profile_pending"
    return "active"


def get_required_steps(status: OnboardingStatus) -> list[RequiredStep]:
    if status == "phone_pending":
        return ["bind_phone", "complete_profile"]
    if status == "profile_pending":
        return ["complete_profile"]
    return []


class PhoneAlreadyBoundError(Exception):
    pass


class WechatBindingError(Exception):
    def __init__(self, code: str, message: str, status_code: int = 409) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code


def _phone_cipher(settings: Settings) -> Fernet:
    digest = hashlib.sha256(settings.phone_encryption_key.encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def bind_phone(db: Session, user: User, phone_info: WechatPhoneInfo, settings: Settings) -> User:
    normalized = normalize_phone(phone_info.country_code, phone_info.pure_phone_number)
    phone_hash = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
    conflict = db.scalar(select(User.id).where(User.phone_number_hash == phone_hash, User.id != user.id))
    if conflict is not None:
        raise PhoneAlreadyBoundError
    user.phone_number_encrypted = _phone_cipher(settings).encrypt(normalized.encode("utf-8")).decode("ascii")
    user.phone_number_hash = phone_hash
    user.phone_country_code = phone_info.country_code.removeprefix("+")
    user.phone_verified_at = datetime.now(UTC)
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise PhoneAlreadyBoundError from error
    db.refresh(user)
    return user


def unbind_phone(db: Session, user: User) -> User:
    user.phone_number_encrypted = None
    user.phone_number_hash = None
    user.phone_country_code = None
    user.phone_verified_at = None
    db.commit()
    db.refresh(user)
    return user


def get_masked_phone(user: User, settings: Settings) -> str | None:
    if not user.phone_number_encrypted:
        return None
    try:
        normalized = _phone_cipher(settings).decrypt(user.phone_number_encrypted.encode("ascii")).decode("utf-8")
    except (InvalidToken, UnicodeError) as error:
        raise ValueError("Stored phone number cannot be decrypted") from error
    prefix = f"+{user.phone_country_code or ''}"
    return mask_phone(normalized.removeprefix(prefix))


def unbind_wechat(db: Session, user: User) -> User:
    if user.password_hash is None and user.phone_verified_at is None:
        raise WechatBindingError(
            "WECHAT_UNBIND_REQUIRES_RECOVERY",
            "解绑微信前请先设置密码或绑定手机号",
        )
    user.wechat_unlinked_at = datetime.now(UTC)
    db.commit()
    db.refresh(user)
    return user


def bind_wechat(db: Session, user: User, openid: str) -> User:
    owner = db.scalar(select(User).where(User.openid == openid, User.id != user.id))
    if owner is not None:
        raise WechatBindingError("WECHAT_ALREADY_BOUND", "该微信账号已绑定其他账号")
    user.openid = openid
    user.wechat_unlinked_at = None
    db.commit()
    db.refresh(user)
    return user
