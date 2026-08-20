import secrets
from dataclasses import dataclass
from datetime import UTC, datetime

import bcrypt
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models.user import User


class AccountAuthError(Exception):
    def __init__(self, code: str, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code


@dataclass(frozen=True)
class AccountLoginResult:
    user: User


def generate_account_number(db: Session) -> str:
    for _ in range(100):
        account_number = str(secrets.randbelow(90_000_000) + 10_000_000)
        if db.scalar(select(User.id).where(User.account_number == account_number)) is None:
            return account_number
    raise AccountAuthError("ACCOUNT_NUMBER_UNAVAILABLE", "账号生成失败", 503)


def set_password(user: User, password: str) -> None:
    user.password_hash = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def login_by_account(db: Session, account_number: str, password: str) -> AccountLoginResult:
    user = db.scalar(select(User).where(User.account_number == account_number))
    if user is not None and user.deactivated_at is not None:
        raise AccountAuthError("ACCOUNT_DEACTIVATED", "账号已注销", 403)
    if user is None or user.password_hash is None:
        raise AccountAuthError("ACCOUNT_LOGIN_FAILED", "账号或密码错误", 401)
    try:
        valid = bcrypt.checkpw(password.encode("utf-8"), user.password_hash.encode("utf-8"))
    except ValueError:
        valid = False
    if not valid:
        raise AccountAuthError("ACCOUNT_LOGIN_FAILED", "账号或密码错误", 401)
    return AccountLoginResult(user=user)


def deactivate_account(db: Session, user: User) -> User:
    user.deactivated_at = datetime.now(UTC)
    db.commit()
    db.refresh(user)
    return user
