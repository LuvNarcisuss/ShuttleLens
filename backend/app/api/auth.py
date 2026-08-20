from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, UploadFile, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import Settings, get_settings
from app.core.security import create_access_token, get_current_user
from app.db.models.user import User
from app.db.session import get_db
from app.schemas.auth import (
    AccountLoginRequest,
    AvatarUploadResponse,
    CurrentUserResponse,
    DeactivateResponse,
    LoginResponse,
    PasswordSetRequest,
    ProfileUpdateRequest,
    UserResponse,
    WechatLoginRequest,
    WechatPhoneRequest,
)
from app.services.account_auth import (
    AccountAuthError,
    deactivate_account,
    login_by_account,
    set_password,
)
from app.services.user_onboarding import (
    PhoneAlreadyBoundError,
    bind_phone,
    get_masked_phone,
    get_onboarding_status,
    get_required_steps,
    WechatBindingError,
    bind_wechat as bind_wechat_account,
    unbind_wechat,
    unbind_phone,
)
from app.services.wechat_auth import WechatAuthClient, WechatAuthError

router = APIRouter(prefix="/auth", tags=["auth"])

MAX_AVATAR_SIZE_BYTES = 5 * 1024 * 1024
ALLOWED_AVATAR_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}


def to_user_response(user: User, settings: Settings) -> UserResponse:
    return UserResponse(
        id=user.id,
        account_number=user.account_number,
        nickname=user.nickname,
        avatar_url=user.avatar_url,
        masked_phone=get_masked_phone(user, settings),
        onboarding_status=get_onboarding_status(user),
        password_set=user.password_hash is not None,
        wechat_bound=user.wechat_unlinked_at is None,
    )


def to_current_user_response(user: User, settings: Settings) -> CurrentUserResponse:
    response = to_user_response(user, settings)
    return CurrentUserResponse(
        **response.model_dump(),
        required_steps=get_required_steps(response.onboarding_status),
    )


@router.post("/wechat/login", response_model=LoginResponse)
def wechat_login(
    request: WechatLoginRequest,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> LoginResponse:
    try:
        openid = WechatAuthClient(settings).code_to_openid(request.login_code)
    except WechatAuthError as error:
        raise HTTPException(
            status_code=error.status_code,
            detail={"code": error.code, "message": str(error)},
        ) from error

    user = db.scalar(select(User).where(User.openid == openid))
    if user is not None and user.deactivated_at is not None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "ACCOUNT_DEACTIVATED", "message": "账号已注销"},
        )
    if user is not None and user.wechat_unlinked_at is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "WECHAT_UNBOUND_REQUIRES_REBIND", "message": "请先通过账号登录后重新绑定微信"},
        )
    if user is None:
        from app.services.account_auth import generate_account_number
        account_number = generate_account_number(db)
        user = User(openid=openid, account_number=account_number)
        db.add(user)
    user.last_login_at = datetime.now(UTC)
    db.commit()
    db.refresh(user)

    user_response = to_user_response(user, settings)

    return LoginResponse(
        access_token=create_access_token(user.id, settings),
        expires_in=settings.access_token_expire_days * 24 * 60 * 60,
        user=user_response,
        required_steps=get_required_steps(user_response.onboarding_status),
    )


@router.post("/wechat/unbind", response_model=CurrentUserResponse)
def unbind_wechat_account(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> CurrentUserResponse:
    try:
        unbind_wechat(db, user)
    except WechatBindingError as error:
        raise HTTPException(
            status_code=error.status_code,
            detail={"code": error.code, "message": str(error)},
        ) from error
    return to_current_user_response(user, settings)


@router.post("/wechat/bind", response_model=CurrentUserResponse)
def bind_wechat_account_route(
    request: WechatLoginRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> CurrentUserResponse:
    try:
        openid = WechatAuthClient(settings).code_to_openid(request.login_code)
        bind_wechat_account(db, user, openid)
    except WechatAuthError as error:
        raise HTTPException(
            status_code=error.status_code,
            detail={"code": error.code, "message": str(error)},
        ) from error
    except WechatBindingError as error:
        raise HTTPException(
            status_code=error.status_code,
            detail={"code": error.code, "message": str(error)},
        ) from error
    return to_current_user_response(user, settings)


@router.post("/wechat/phone", response_model=CurrentUserResponse)
def bind_wechat_phone(
    request: WechatPhoneRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> CurrentUserResponse:
    try:
        phone_info = WechatAuthClient(settings).code_to_phone(request.phone_code)
        bind_phone(db, user, phone_info, settings)
    except WechatAuthError as error:
        raise HTTPException(
            status_code=error.status_code,
            detail={"code": error.code, "message": str(error)},
        ) from error
    except PhoneAlreadyBoundError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "PHONE_ALREADY_BOUND", "message": "该手机号已绑定其他账号"},
        ) from error
    return to_current_user_response(user, settings)


@router.delete("/wechat/phone", response_model=CurrentUserResponse)
def unbind_wechat_phone(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> CurrentUserResponse:
    """
    解绑当前用户的手机号。
    """
    if not user.phone_number_encrypted:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "PHONE_NOT_BOUND", "message": "用户未绑定手机号"},
        )
    try:
        unbind_phone(db, user)
    except Exception as error:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "UNBIND_FAILED", "message": str(error)},
        ) from error
    return to_current_user_response(user, settings)


@router.get("/me", response_model=CurrentUserResponse)
def current_user(
    user: User = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> CurrentUserResponse:
    return to_current_user_response(user, settings)


@router.put("/me", response_model=CurrentUserResponse)
def update_current_user(
    request: ProfileUpdateRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> CurrentUserResponse:
    user.nickname = request.nickname
    user.avatar_url = str(request.avatar_url)
    user.profile_completed_at = datetime.now(UTC)
    db.commit()
    db.refresh(user)
    return to_current_user_response(user, settings)


@router.post("/me/avatar", response_model=AvatarUploadResponse)
async def upload_avatar(
    avatar: UploadFile,
    user: User = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> AvatarUploadResponse:
    suffix = ALLOWED_AVATAR_TYPES.get(avatar.content_type or "")
    if suffix is None:
        raise HTTPException(status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail="Unsupported avatar type")

    content = await avatar.read()
    if not content or len(content) > MAX_AVATAR_SIZE_BYTES:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="Avatar must be 5 MB or smaller")

    storage_dir = Path(settings.avatar_storage_dir)
    storage_dir.mkdir(parents=True, exist_ok=True)
    filename = f"{user.id}-{uuid4().hex}{suffix}"
    (storage_dir / filename).write_bytes(content)
    base_url = settings.public_base_url.rstrip("/")
    return AvatarUploadResponse(avatar_url=f"{base_url}/uploads/avatars/{filename}")


@router.post("/account/login", response_model=LoginResponse)
def account_login(
    request: AccountLoginRequest,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> LoginResponse:
    """Login by account number and password."""
    try:
        result = login_by_account(db, request.account_number, request.password)
    except AccountAuthError as error:
        raise HTTPException(
            status_code=error.status_code,
            detail={"code": error.code, "message": str(error)},
        ) from error

    user = result.user
    user.last_login_at = datetime.now(UTC)
    db.commit()
    db.refresh(user)

    user_response = to_user_response(user, settings)
    return LoginResponse(
        access_token=create_access_token(user.id, settings),
        expires_in=settings.access_token_expire_days * 24 * 60 * 60,
        user=user_response,
        required_steps=get_required_steps(user_response.onboarding_status),
    )


@router.post("/account/password", response_model=CurrentUserResponse)
def set_account_password(
    request: PasswordSetRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> CurrentUserResponse:
    """Set or update password for current user."""
    try:
        set_password(user, request.password)
        db.commit()
        db.refresh(user)
    except AccountAuthError as error:
        raise HTTPException(
            status_code=error.status_code,
            detail={"code": error.code, "message": str(error)},
        ) from error
    return to_current_user_response(user, settings)


@router.post("/deactivate", response_model=DeactivateResponse)
def deactivate_current_account(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DeactivateResponse:
    deactivate_account(db, user)
    return DeactivateResponse(status="deactivated")
