using Aegis.Api.Auth;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.Options;

namespace Aegis.Api.Controllers;

[ApiController]
[Route("api/auth")]
[EnableRateLimiting("auth")]
public sealed class AuthController(AuthService auth, IOptions<AuthOptions> options) : ControllerBase
{
    public sealed record LoginRequest(string LoginId, string Password, bool RememberMe = false);
    public sealed record PasswordRequest(string NewPassword, string? CurrentPassword = null);
    public sealed record LinkRequest(string Token, string NewPassword);

    [HttpPost("login")]
    [AllowAnonymous]
    public async Task<IActionResult> Login([FromBody] LoginRequest req, CancellationToken ct)
    {
        var r = await auth.LoginAsync(req.LoginId, req.Password, req.RememberMe, HttpContext, ct);
        if (!r.Ok) return StatusCode(r.ErrorCode == AuthService.TooMany ? 429 : 401, new { error = r.Message, code = r.ErrorCode });
        return Ok(Issue(r.Tokens!));
    }

    [HttpPost("refresh")]
    [AllowAnonymous]
    public async Task<IActionResult> Refresh(CancellationToken ct)
    {
        // 完全沒有 cookie = 本來就沒登入（開機還原 session 的正常情況）→ 204，不當錯誤；cookie 無效才 401
        if (!Request.Cookies.TryGetValue(options.Value.RefreshCookieName, out var rt) || string.IsNullOrEmpty(rt))
            return NoContent();
        var pair = await auth.RefreshAsync(rt, ct);
        if (pair is null) { ClearCookie(); return Unauthorized(new { error = "登入已逾期，請重新登入" }); }
        return Ok(Issue(pair));
    }

    [HttpPost("logout")]
    [AllowAnonymous]
    public async Task<IActionResult> Logout(CancellationToken ct)
    {
        if (Request.Cookies.TryGetValue(options.Value.RefreshCookieName, out var rt) && !string.IsNullOrEmpty(rt)) await auth.LogoutAsync(rt, ct);
        ClearCookie();
        return NoContent();
    }

    [HttpGet("me")]
    [Authorize]
    public IActionResult Me() => Ok(CurrentUser.From(User).ToDto());

    [HttpPost("change-password")]
    [Authorize]
    public async Task<IActionResult> ChangePassword([FromBody] PasswordRequest req, CancellationToken ct)
    {
        // 自己主動改密碼要先驗目前密碼（= Firebase reauthenticate）；強制改密（臨時 / 啟用後）不必帶
        if (req.CurrentPassword != null && !await auth.CheckPasswordAsync(CurrentUser.From(User).UserId, req.CurrentPassword, ct))
            return BadRequest(new { error = "目前密碼錯誤", code = "auth/wrong-password" });
        var problem = await auth.ChangePasswordAsync(CurrentUser.From(User).UserId, req.NewPassword, HttpContext, ct);
        return problem is null ? Ok(new { ok = true, message = "密碼已更新" }) : BadRequest(new { error = problem });
    }

    // 啟用 / 重設連結（管理員寄出或親手轉交）
    [HttpPost("activate")]
    [AllowAnonymous]
    public async Task<IActionResult> Activate([FromBody] LinkRequest req, CancellationToken ct)
    {
        var (ok, msg) = await auth.UseLinkAsync(req.Token, req.NewPassword, HttpContext, ct);
        return ok ? Ok(new { ok = true, message = msg, purpose = msg == "帳號啟用成功" ? "activation" : "reset" }) : BadRequest(new { error = msg });
    }

    private object Issue(TokenPair pair)
    {
        var cookie = new CookieOptions
        {
            HttpOnly = true, Secure = Request.IsHttps, SameSite = SameSiteMode.Strict, Path = "/api/auth",
            Expires = pair.Persistent ? pair.RefreshExpiresAt : null,   // 不勾「記住我」= session cookie，關瀏覽器就失效
        };
        Response.Cookies.Append(options.Value.RefreshCookieName, pair.RefreshToken, cookie);
        var principal = new System.IdentityModel.Tokens.Jwt.JwtSecurityTokenHandler().ReadJwtToken(pair.AccessToken);
        return new { accessToken = pair.AccessToken, expiresAt = pair.AccessExpiresAt,
                     user = CurrentUser.From(new System.Security.Claims.ClaimsPrincipal(new System.Security.Claims.ClaimsIdentity(principal.Claims))).ToDto() };
    }

    private void ClearCookie() => Response.Cookies.Delete(options.Value.RefreshCookieName, new CookieOptions { Path = "/api/auth" });
}
