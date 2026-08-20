from dataclasses import dataclass

import httpx

from app.core.config import Settings


MOCK_OPENID = "mock_local_user"
MOCK_PHONE_NUMBER = "13800138000"


class WechatAuthError(Exception):
    def __init__(self, code: str, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code


@dataclass(frozen=True)
class WechatPhoneInfo:
    pure_phone_number: str
    country_code: str
    watermark_appid: str


class WechatAuthClient:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def code_to_openid(self, login_code: str) -> str:
        if self.settings.wechat_auth_mode == "mock":
            return MOCK_OPENID

        try:
            response = httpx.get(
                "https://api.weixin.qq.com/sns/jscode2session",
                params={
                    "appid": self.settings.wechat_app_id,
                    "secret": self.settings.wechat_app_secret,
                    "js_code": login_code,
                    "grant_type": "authorization_code",
                },
                timeout=5.0,
            )
            response.raise_for_status()
        except httpx.HTTPError as error:
            raise WechatAuthError(
                "WECHAT_UPSTREAM_UNAVAILABLE", "微信登录服务暂不可用", 503
            ) from error

        payload = response.json()
        openid = payload.get("openid")
        if not isinstance(openid, str) or not openid:
            raise WechatAuthError("WECHAT_LOGIN_CODE_INVALID", "微信登录凭证无效", 401)
        return openid

    def code_to_phone(self, phone_code: str) -> WechatPhoneInfo:
        if self.settings.wechat_auth_mode == "mock":
            return WechatPhoneInfo(
                pure_phone_number=MOCK_PHONE_NUMBER,
                country_code="86",
                watermark_appid=self.settings.wechat_app_id or "mock-app-id",
            )

        try:
            token_response = httpx.post(
                "https://api.weixin.qq.com/cgi-bin/stable_token",
                json={
                    "grant_type": "client_credential",
                    "appid": self.settings.wechat_app_id,
                    "secret": self.settings.wechat_app_secret,
                    "force_refresh": False,
                },
                timeout=5.0,
            )
            token_response.raise_for_status()
            token_payload = token_response.json()
            access_token = token_payload.get("access_token")
            if not isinstance(access_token, str) or not access_token:
                raise WechatAuthError(
                    "WECHAT_UPSTREAM_UNAVAILABLE", "微信手机号服务暂不可用", 503
                )

            phone_response = httpx.post(
                "https://api.weixin.qq.com/wxa/business/getuserphonenumber"
                f"?access_token={access_token}",
                json={"code": phone_code},
                timeout=5.0,
            )
            phone_response.raise_for_status()
        except WechatAuthError:
            raise
        except httpx.HTTPError as error:
            raise WechatAuthError(
                "WECHAT_UPSTREAM_UNAVAILABLE", "微信手机号服务暂不可用", 503
            ) from error

        payload = phone_response.json()
        errcode = payload.get("errcode", 0)
        if errcode:
            error_map = {
                40029: ("WECHAT_PHONE_CODE_INVALID", "手机号授权凭证无效", 400),
                40163: ("WECHAT_PHONE_CODE_EXPIRED", "手机号授权凭证已失效", 400),
                45009: ("WECHAT_PHONE_QUOTA_EXHAUSTED", "手机号验证额度不足", 429),
            }
            code, message, status_code = error_map.get(
                errcode,
                ("WECHAT_UPSTREAM_UNAVAILABLE", "微信手机号服务暂不可用", 503),
            )
            raise WechatAuthError(code, message, status_code)

        phone_info = payload.get("phone_info")
        if not isinstance(phone_info, dict):
            raise WechatAuthError("WECHAT_PHONE_CODE_INVALID", "手机号授权凭证无效", 400)
        watermark = phone_info.get("watermark")
        watermark_appid = watermark.get("appid") if isinstance(watermark, dict) else None
        pure_phone = phone_info.get("purePhoneNumber")
        country_code = phone_info.get("countryCode")
        if (
            not isinstance(pure_phone, str)
            or not isinstance(country_code, str)
            or watermark_appid != self.settings.wechat_app_id
        ):
            raise WechatAuthError("WECHAT_PHONE_CODE_INVALID", "手机号授权凭证无效", 400)
        return WechatPhoneInfo(pure_phone, country_code, watermark_appid)
