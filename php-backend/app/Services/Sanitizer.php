<?php

namespace App\Services;

/**
 * HTML 清理 + PII 偵測 — 對應 api/_lib/sanitize.js
 *
 * 移除 <script>、事件屬性 (on*)、javascript:/vbscript:/data: URL，
 * 以及 iframe/object/embed/form/input/meta/link/base/svg 等危險標籤。
 */
class Sanitizer
{
    /** 與 Node 版相同，目前 sanitizeHtml 採黑名單策略，此白名單保留供日後參考 */
    private const ALLOWED_TAGS = [
        'p', 'br', 'b', 'i', 'em', 'strong', 'u', 'h1', 'h2', 'h3', 'h4',
        'ul', 'ol', 'li', 'a', 'span', 'div', 'table', 'tr', 'td', 'th', 'thead', 'tbody',
    ];

    public static function sanitizeHtml($html): string
    {
        if (!is_string($html) || $html === '') {
            return '';
        }
        // 移除 <script>...</script>（含多行）
        $html = preg_replace('/<script[\s\S]*?<\/script>/i', '', $html);
        // 移除 <style>...</style>
        $html = preg_replace('/<style[\s\S]*?<\/style>/i', '', $html);
        // 移除所有事件屬性 (on*)
        $html = preg_replace('/\s+on\w+\s*=\s*(?:"[^"]*"|\'[^\']*\'|[^\s>]+)/i', '', $html);
        // 移除 javascript: / vbscript: / data: URL
        $html = preg_replace(
            '/(?:href|src|action)\s*=\s*(?:"(?:javascript|vbscript|data):[^"]*"|\'(?:javascript|vbscript|data):[^\']*\')/i',
            '',
            $html
        );
        // 移除 iframe/object/embed/form/input/textarea/meta/link/base/svg
        $html = preg_replace('/<\/?(iframe|object|embed|form|input|textarea|meta|link|base|svg)[\s\S]*?>/i', '', $html);

        return $html;
    }

    /** @return array{valid:bool,message?:string} */
    public static function validatePromptLength($prompt, int $maxLength = 50000): array
    {
        if (!is_string($prompt) || $prompt === '') {
            return ['valid' => false, 'message' => '未提供 prompt'];
        }
        if (mb_strlen($prompt) > $maxLength) {
            return ['valid' => false, 'message' => "prompt 超過長度限制 ({$maxLength} 字元)"];
        }
        return ['valid' => true];
    }

    /**
     * 偵測台灣身分證 / 手機等高敏 PII（個資法 §8 跨境傳輸前必查）
     * @return array{hasPii:bool,hits:string[]}
     */
    public static function detectSensitivePii($text): array
    {
        if (!is_string($text) || $text === '') {
            return ['hasPii' => false, 'hits' => []];
        }
        $hits = [];
        // 中華民國身分證字號
        if (preg_match('/\b[A-Z][12]\d{8}\b/', $text)) {
            $hits[] = 'rocId';
        }
        // 台灣手機（允許一個分隔符）
        if (preg_match('/\b09\d{2}[-\s]?\d{6}\b/', $text)) {
            $hits[] = 'twMobile';
        }
        return ['hasPii' => count($hits) > 0, 'hits' => $hits];
    }
}
