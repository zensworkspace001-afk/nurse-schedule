using System.Globalization;
using System.Text;
using System.Text.Json;

namespace Aegis.Security;

// 明文值 = Node serialize() 的 t：null | num | bool | str | json
public abstract record FieldPlain
{
    public sealed record Null : FieldPlain;
    public sealed record Num(double Value) : FieldPlain;
    public sealed record Bool(bool Value) : FieldPlain;
    public sealed record Str(string Value) : FieldPlain;
    public sealed record Json(JsonElement Value) : FieldPlain;   // 物件 / 陣列，保留原始鍵順序

    public static FieldPlain Of(string? s) => s is null ? new Null() : new Str(s);
}

// { t, v } 信封 — 與 Node JSON.stringify({ t, v }) 逐位元組相同（System.Text.Json 預設會把中文跳脫成 \uXXXX、
// 數字格式也不同，所以自己寫；只需要 JSON.stringify 的子集：字串、數字、布林、null、物件、陣列）
public static class JsEnvelope
{
    public static string Serialize(FieldPlain v)
    {
        var sb = new StringBuilder();
        switch (v)
        {
            case FieldPlain.Null: sb.Append("{\"t\":\"null\"}"); return sb.ToString();
            case FieldPlain.Num n: sb.Append("{\"t\":\"num\",\"v\":"); WriteNumber(sb, n.Value); break;
            case FieldPlain.Bool b: sb.Append("{\"t\":\"bool\",\"v\":").Append(b.Value ? "true" : "false"); break;
            case FieldPlain.Str s: sb.Append("{\"t\":\"str\",\"v\":"); WriteString(sb, s.Value); break;
            case FieldPlain.Json j: sb.Append("{\"t\":\"json\",\"v\":"); WriteElement(sb, j.Value); break;
            default: throw new ArgumentOutOfRangeException(nameof(v));
        }
        return sb.Append('}').ToString();
    }

    public static FieldPlain Deserialize(string envelope)
    {
        using var doc = JsonDocument.Parse(envelope);
        var root = doc.RootElement;
        string t = root.GetProperty("t").GetString()!;
        if (t == "null") return new FieldPlain.Null();
        var v = root.GetProperty("v");
        return t switch
        {
            "num" => new FieldPlain.Num(v.GetDouble()),
            "bool" => new FieldPlain.Bool(v.GetBoolean()),
            "str" => new FieldPlain.Str(v.GetString()!),
            _ => new FieldPlain.Json(v.Clone()),
        };
    }

    private static void WriteElement(StringBuilder sb, JsonElement e)
    {
        switch (e.ValueKind)
        {
            case JsonValueKind.Object:
                sb.Append('{');
                bool first = true;
                foreach (var p in e.EnumerateObject())
                {
                    if (!first) sb.Append(',');
                    first = false;
                    WriteString(sb, p.Name);
                    sb.Append(':');
                    WriteElement(sb, p.Value);
                }
                sb.Append('}');
                break;
            case JsonValueKind.Array:
                sb.Append('[');
                int i = 0;
                foreach (var x in e.EnumerateArray()) { if (i++ > 0) sb.Append(','); WriteElement(sb, x); }
                sb.Append(']');
                break;
            case JsonValueKind.String: WriteString(sb, e.GetString()!); break;
            case JsonValueKind.Number: WriteNumber(sb, e.GetDouble()); break;
            case JsonValueKind.True: sb.Append("true"); break;
            case JsonValueKind.False: sb.Append("false"); break;
            default: sb.Append("null"); break;
        }
    }

    // ECMAScript QuoteJSONString：只跳脫 " \ 與控制字元；其餘 Unicode（含中文、emoji）原樣輸出
    private static void WriteString(StringBuilder sb, string s)
    {
        sb.Append('"');
        for (int i = 0; i < s.Length; i++)
        {
            char c = s[i];
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                    else if (char.IsSurrogate(c) && !(char.IsHighSurrogate(c) && i + 1 < s.Length && char.IsLowSurrogate(s[i + 1])) &&
                             !(char.IsLowSurrogate(c) && i > 0 && char.IsHighSurrogate(s[i - 1])))
                        sb.Append("\\u").Append(((int)c).ToString("x4"));   // 孤立的代理字元（ES2019 well-formed JSON.stringify）
                    else sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
    }

    // ECMAScript Number::toString(10)：最短可還原的位數，指數 ≥ 21 或 ≤ -7 才用科學記號（1e+21、1e-7）
    private static void WriteNumber(StringBuilder sb, double x)
    {
        if (double.IsNaN(x) || double.IsInfinity(x)) { sb.Append("null"); return; }   // JSON.stringify 對 NaN / Infinity 輸出 null
        if (x == 0) { sb.Append('0'); return; }                                         // -0 也輸出 "0"
        if (x < 0) { sb.Append('-'); x = -x; }
        // .NET Core 3.0+ 的 "R" 是最短可還原表示；取出有效數字 digits 與十進位指數 n（x = 0.digits × 10^n）
        string shortest = x.ToString("R", CultureInfo.InvariantCulture);
        string digits; int exp;
        {
            string m = shortest; int e = 0;
            int ei = m.IndexOfAny(['E', 'e']);
            if (ei >= 0) { e = int.Parse(m[(ei + 1)..], CultureInfo.InvariantCulture); m = m[..ei]; }
            int dot = m.IndexOf('.');
            string intPart = dot >= 0 ? m[..dot] : m, frac = dot >= 0 ? m[(dot + 1)..] : "";
            string all = (intPart + frac).TrimStart('0');
            int lead = (intPart + frac).Length - all.Length;   // 前導 0 個數
            digits = all.TrimEnd('0');
            if (digits.Length == 0) digits = "0";
            exp = intPart.Length + e - lead;                    // x = 0.digits × 10^exp
        }
        int k = digits.Length, n = exp;
        if (k <= n && n <= 21) sb.Append(digits).Append('0', n - k);
        else if (0 < n && n <= 21) sb.Append(digits, 0, n).Append('.').Append(digits, n, k - n);
        else if (-6 < n && n <= 0) sb.Append("0.").Append('0', -n).Append(digits);
        else
        {
            int e = n - 1;
            sb.Append(digits[0]);
            if (k > 1) sb.Append('.').Append(digits, 1, k - 1);
            sb.Append('e').Append(e >= 0 ? '+' : '-').Append(Math.Abs(e));
        }
    }
}
