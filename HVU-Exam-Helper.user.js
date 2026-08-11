// ==UserScript==
// @name         HVU Exam Helper
// @namespace    http://sv.shop/
// @version      3.1.3
// @description  Lưu đề thi HVU ra Word + nhận diện và tải PDF, video, Word và tệp đính kèm
// @author       SV Shop - Zalo 0359677390
// @match        https://sinhvien.hvu.edu.vn/*
// @match        https://*.ictu.edu.vn/*
// @icon         https://sinhvien.hvu.edu.vn/favicon.ico
// @grant        unsafeWindow
// @grant        GM_info
// @grant        GM_download
// @grant        GM_notification
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      raw.githubusercontent.com
// @run-at       document-start
// @noframes
// @downloadURL  https://raw.githubusercontent.com/minhdat253/hvu-exam-helper/main/HVU-Exam-Helper.user.js
// @updateURL    https://raw.githubusercontent.com/minhdat253/hvu-exam-helper/main/HVU-Exam-Helper.user.js
// ==/UserScript==

(function () {
    'use strict';

    // =====================================================================
    // CONFIG
    // =====================================================================
    const CONFIG = Object.freeze({
        ZALO: '0359677390',
        FACEBOOK: 'https://www.facebook.com/Dangdat352',
        SHOP: 'https://docs.google.com/spreadsheets/d/1KoQbsf7xffIciikuasRItIdpMyX4NXaYBRTYX5p5tGU/edit?usp=sharing',
        UPDATE_URL: 'https://raw.githubusercontent.com/minhdat253/hvu-exam-helper/main/HVU-Exam-Helper.user.js',
        FALLBACK_VERSION: '3.1.3',
        STORAGE: {
            EXAM: 'currentTest',
            MENU: 'hvuMenuStateV3',
            SETTINGS: 'hvuUiSettingsV1'
        },
        DOM_SCAN_DEBOUNCE_MS: 140,
        FILE_RESOLVE_TIMEOUT_MS: 3200,
        MEDIA_PROBE_INTERVAL_MS: 35,
        JSON_ATTACHMENT_MAX_DEPTH: 7,
        LOG_PREFIX: '[HVU Helper]'
    });

    const VERSION =
        typeof GM_info !== 'undefined' && GM_info?.script?.version
            ? GM_info.script.version
            : CONFIG.FALLBACK_VERSION;

    const FILE_TYPES = Object.freeze({
        pdf: {
            label: 'PDF',
            icon: 'PDF',
            extensions: ['pdf'],
            mimes: ['application/pdf']
        },
        video: {
            label: 'Video',
            icon: 'VID',
            extensions: ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi'],
            mimes: ['video/']
        },
        word: {
            label: 'Word',
            icon: 'DOC',
            extensions: ['doc', 'docx'],
            mimes: [
                'application/msword',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            ]
        },
        excel: {
            label: 'Excel',
            icon: 'XLS',
            extensions: ['xls', 'xlsx', 'csv'],
            mimes: [
                'application/vnd.ms-excel',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'text/csv'
            ]
        },
        powerpoint: {
            label: 'PowerPoint',
            icon: 'PPT',
            extensions: ['ppt', 'pptx'],
            mimes: [
                'application/vnd.ms-powerpoint',
                'application/vnd.openxmlformats-officedocument.presentationml.presentation'
            ]
        },
        audio: {
            label: 'Audio',
            icon: 'AUD',
            extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg'],
            mimes: ['audio/']
        },
        image: {
            label: 'Ảnh',
            icon: 'IMG',
            extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'],
            mimes: ['image/']
        },
        archive: {
            label: 'Nén',
            icon: 'ZIP',
            extensions: ['zip', 'rar', '7z', 'tar', 'gz'],
            mimes: ['application/zip', 'application/x-rar-compressed']
        },
        stream: {
            label: 'Video stream',
            icon: 'HLS',
            extensions: ['m3u8'],
            mimes: ['application/vnd.apple.mpegurl', 'application/x-mpegurl']
        },
        other: {
            label: 'Tệp',
            icon: 'FILE',
            extensions: [],
            mimes: []
        }
    });

    const KNOWN_EXTENSIONS = Object.values(FILE_TYPES)
        .flatMap(type => type.extensions)
        .filter(Boolean);

    const FILE_NAME_RE = new RegExp(
        `([^\\\\/:*?"<>|\\r\\n]{1,140}\\.(?:${KNOWN_EXTENSIONS.join('|')}))(?:\\s|$|[)\\],;])`,
        'i'
    );

    // =====================================================================
    // STATE
    // =====================================================================
    const DATA = {
        questions: {},
        testId: null,
        userAnswers: {},
        score: null,
        timestamp: null,
        captured: false
    };

    /** Visible, user-facing attachments only. */
    const ATTACHMENTS = new Map();

    /** Technical network records stay hidden from the menu. */
    const INTERNAL_FILES = new Map();
    const CAPTURED_BY_FILE_ID = new Map();
    const CAPTURED_BY_URL = new Map();

    /** Event listeners waiting for a freshly resolved signed/media URL. */
    const INTERNAL_FILE_LISTENERS = new Set();

    const UI = {
        host: null,
        shadow: null,
        scanTimer: null,
        observer: null,
        frameObservers: new WeakMap(),
        processedTextNodes: new WeakSet(),
        lastCaptureAt: 0
    };

    log(`Userscript v${VERSION} starting`);

    // =====================================================================
    // UTILITIES
    // =====================================================================
    function log(...args) {
        console.log(CONFIG.LOG_PREFIX, ...args);
    }

    function warn(...args) {
        console.warn(CONFIG.LOG_PREFIX, ...args);
    }

    function notify(text, title = 'HVU Exam Helper') {
        try {
            GM_notification({ title, text, timeout: 2800 });
        } catch {
            // Notification permission can be disabled. The tool should keep working.
        }
    }

    function safeJsonParse(value, fallback = null) {
        if (typeof value !== 'string' || !value.trim()) return fallback;
        try {
            return JSON.parse(value);
        } catch {
            return fallback;
        }
    }

    function isBlobLike(value) {
        return Boolean(
            value &&
            typeof value === 'object' &&
            typeof value.type === 'string' &&
            typeof value.size === 'number' &&
            typeof value.slice === 'function'
        );
    }

    function isElementNode(value) {
        return Boolean(
            value &&
            value.nodeType === 1 &&
            typeof value.querySelectorAll === 'function'
        );
    }

    function isDocumentNode(value) {
        return Boolean(value && value.nodeType === 9);
    }

    function cleanHtml(html) {
        if (html === null || html === undefined) return '';
        if (typeof html !== 'string') return String(html);
        const div = document.createElement('div');
        div.innerHTML = html;
        return (div.innerText || div.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function escapeHtml(text) {
        return String(text ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function sanitizeFilename(name, fallback = 'tep-dinh-kem') {
        const cleaned = String(name || fallback)
            .replace(/[\\/:*?"<>|]+/g, '_')
            .replace(/\s+/g, ' ')
            .trim();
        return cleaned || fallback;
    }

    function decodeMaybe(value) {
        try {
            return decodeURIComponent(value);
        } catch {
            return value;
        }
    }

    function getUrlPathname(url) {
        try {
            return new URL(url, location.href).pathname;
        } catch {
            return String(url || '').split('?')[0].split('#')[0];
        }
    }

    function getFilenameFromUrl(url) {
        const pathname = getUrlPathname(url);
        const last = pathname.split('/').filter(Boolean).pop() || '';
        return sanitizeFilename(decodeMaybe(last), '');
    }

    function getExtension(filename) {
        const match = String(filename || '').toLowerCase().match(/\.([a-z0-9]{1,8})$/i);
        return match ? match[1] : '';
    }

    function getFilenameFromContentDisposition(value) {
        if (!value) return '';

        const utf8 = value.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
        if (utf8?.[1]) return sanitizeFilename(decodeMaybe(utf8[1].replace(/^["']|["']$/g, '')));

        const normal = value.match(/filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i);
        const result = normal?.[1] || normal?.[2] || '';
        return sanitizeFilename(result.replace(/^["']|["']$/g, '').trim(), '');
    }

    function inferFileKind({ filename = '', url = '', mime = '' } = {}) {
        const ext = getExtension(filename) || getExtension(getFilenameFromUrl(url));
        const normalizedMime = String(mime || '').toLowerCase();

        for (const [kind, spec] of Object.entries(FILE_TYPES)) {
            if (kind === 'other') continue;
            if (ext && spec.extensions.includes(ext)) return kind;
            if (
                normalizedMime &&
                spec.mimes.some(prefix =>
                    prefix.endsWith('/')
                        ? normalizedMime.startsWith(prefix)
                        : normalizedMime.includes(prefix)
                )
            ) {
                return kind;
            }
        }

        return 'other';
    }

    function looksLikeFileUrl(url, mime = '') {
        if (!url || typeof url !== 'string') return false;
        if (url.startsWith('blob:')) return true;

        const kind = inferFileKind({ url, mime });
        if (kind !== 'other') return true;

        return /\/(?:api\/)?aws\/file\/\d+/i.test(url) ||
            /\/files?\//i.test(url) ||
            /download/i.test(url);
    }

    function normalizeFilenameKey(name) {
        return String(name || '')
            .normalize('NFC')
            .trim()
            .toLowerCase();
    }

    function stableUrlKey(url) {
        const normalized = normalizeUrlCandidate(url);
        if (!normalized) return '';
        if (normalized.startsWith('blob:')) return normalized;

        try {
            const parsed = new URL(normalized, location.href);
            parsed.hash = '';
            parsed.search = '';
            return parsed.href;
        } catch {
            return normalized.split('?')[0].split('#')[0];
        }
    }

    function getFileIdFromUrl(url) {
        return String(url || '').match(/\/(?:api\/)?aws\/file\/([^/?#]+)/i)?.[1] || '';
    }

    function isFileApiUrl(url) {
        return /\/(?:api\/)?aws\/file\/[^/?#]+/i.test(String(url || ''));
    }

    function isTechnicalFilename(name) {
        const cleaned = sanitizeFilename(name, '');
        if (!cleaned) return true;

        const base = cleaned.replace(/\.[a-z0-9]{1,8}$/i, '');
        if (!base) return true;
        if (/^\d+$/.test(base)) return true;
        if (/^[a-f0-9]{16,}$/i.test(base)) return true;
        if (/^[a-z0-9_-]{20,}$/i.test(base) && !/[\s\u00C0-\u024F]/.test(base)) return true;
        if (/^(?:blob|file|download|attachment|document|resource|api)$/i.test(base)) return true;

        return false;
    }

    function isUserFacingFilename(name, kind = 'other') {
        const cleaned = sanitizeFilename(name, '');
        if (!cleaned || isTechnicalFilename(cleaned)) return false;

        const ext = getExtension(cleaned);
        if (ext && KNOWN_EXTENSIONS.includes(ext)) return true;

        // Allow a readable title without extension only when the type is already known.
        return kind !== 'other' && /[\s\u00C0-\u024F]/.test(cleaned);
    }

    function makeAttachmentKey({ fileId, name, url }) {
        if (fileId) return `id:${fileId}`;
        if (name) return `name:${normalizeFilenameKey(name)}`;
        if (url) return `url:${stableUrlKey(url)}`;
        return '';
    }

    function friendlyUnknownFilename(kind, suffix = '') {
        const baseByKind = {
            pdf: 'Tai lieu PDF',
            video: 'Video dinh kem',
            word: 'Tai lieu Word',
            excel: 'Bang tinh',
            powerpoint: 'Bai trinh chieu',
            audio: 'Audio dinh kem',
            image: 'Hinh anh'
        };
        const extByKind = {
            pdf: 'pdf',
            video: 'mp4',
            word: 'docx',
            excel: 'xlsx',
            powerpoint: 'pptx',
            audio: 'mp3',
            image: 'jpg'
        };
        const base = baseByKind[kind] || 'Tep dinh kem';
        const ext = extByKind[kind] || '';
        return `${base}${suffix ? ` ${suffix}` : ''}${ext ? `.${ext}` : ''}`;
    }

    function normalizeUrlCandidate(url) {
        if (!url || typeof url !== 'string') return '';
        const trimmed = url.trim();
        if (!trimmed) return '';
        if (trimmed.startsWith('blob:')) return trimmed;
        try {
            return new URL(trimmed, location.href).href;
        } catch {
            return trimmed;
        }
    }

    function extractSignedFilePayload(payload) {
        const result = {
            url: '',
            name: '',
            mime: '',
            id: ''
        };

        if (!payload) return result;

        if (typeof payload === 'string') {
            result.url = payload;
            return result;
        }

        if (typeof payload !== 'object') return result;

        const urlKeys = [
            'url', 'link', 'signed_url', 'signedUrl', 'download_url',
            'downloadUrl', 'file_url', 'fileUrl', 'path'
        ];
        const nameKeys = [
            'file_name', 'fileName', 'filename', 'name',
            'original_name', 'originalName', 'title'
        ];
        const mimeKeys = ['mime', 'mime_type', 'mimeType', 'content_type', 'contentType'];
        const idKeys = ['id', 'file_id', 'fileId'];

        for (const key of urlKeys) {
            if (typeof payload[key] === 'string' && payload[key]) {
                result.url = payload[key];
                break;
            }
        }
        for (const key of nameKeys) {
            if (typeof payload[key] === 'string' && payload[key]) {
                result.name = payload[key];
                break;
            }
        }
        for (const key of mimeKeys) {
            if (typeof payload[key] === 'string' && payload[key]) {
                result.mime = payload[key];
                break;
            }
        }
        for (const key of idKeys) {
            if (payload[key] !== null && payload[key] !== undefined) {
                result.id = String(payload[key]);
                break;
            }
        }

        return result;
    }

    // =====================================================================
    // GENERIC ATTACHMENT DISCOVERY FROM JSON
    // =====================================================================
    function firstStringField(object, keys) {
        if (!object || typeof object !== 'object') return '';
        for (const key of keys) {
            const value = object[key];
            if (typeof value === 'string' && value.trim()) return value.trim();
            if ((typeof value === 'number' || typeof value === 'bigint') && /(?:^|_)id$/i.test(key)) {
                return String(value);
            }
        }
        return '';
    }

    function pathSuggestsVideo(path) {
        return /(?:^|[._-])(video|videos|media|lecture|lesson_video|video_lesson|clip|stream|playback)(?:$|[._-])/i.test(String(path || ''));
    }

    function pathSuggestsAttachment(path) {
        return /file|attach|document|resource|material|slide|tailieu|tai_lieu|video|media|download/i.test(String(path || ''));
    }

    function captureAttachmentsFromJson(responseUrl, responseText) {
        const payload = safeJsonParse(responseText, null);
        if (!payload || typeof payload !== 'object') return;

        // IMPORTANT (v3.0.6): JSON responses from the LMS can contain the whole
        // course/lesson tree. They are useful for resolving file/video URLs, but
        // MUST NOT directly populate the visible menu. Otherwise one opened
        // lesson can suddenly show dozens or hundreds of files from other lessons.
        //
        // JSON-discovered objects are therefore stored only in INTERNAL_FILES.
        // A file becomes visible only when the current DOM contains a matching
        // filename, link, or media player.
        const seen = new WeakSet();
        const urlKeys = [
            'url', 'link', 'src', 'path', 'file', 'file_url', 'fileUrl',
            'download_url', 'downloadUrl', 'signed_url', 'signedUrl',
            'video_url', 'videoUrl', 'stream_url', 'streamUrl',
            'play_url', 'playUrl', 'playback_url', 'playbackUrl', 'hls', 'm3u8'
        ];
        const nameKeys = [
            'file_name', 'fileName', 'filename', 'original_name', 'originalName',
            'display_name', 'displayName', 'title', 'name', 'label'
        ];
        const mimeKeys = ['mime', 'mime_type', 'mimeType', 'content_type', 'contentType', 'file_type', 'fileType'];
        const idKeys = ['file_id', 'fileId', 'document_id', 'documentId', 'attachment_id', 'attachmentId', 'video_id', 'videoId', 'id'];

        function visit(node, path = 'root', depth = 0) {
            if (!node || depth > CONFIG.JSON_ATTACHMENT_MAX_DEPTH) return;

            if (Array.isArray(node)) {
                for (let i = 0; i < node.length; i += 1) {
                    visit(node[i], `${path}.${i}`, depth + 1);
                }
                return;
            }

            if (typeof node !== 'object') return;
            if (seen.has(node)) return;
            seen.add(node);

            let rawUrl = firstStringField(node, urlKeys);
            let name = firstStringField(node, nameKeys);
            let mime = firstStringField(node, mimeKeys);
            let fileId = firstStringField(node, idKeys);

            rawUrl = normalizeUrlCandidate(rawUrl);
            name = sanitizeFilename(name, '');
            mime = String(mime || '').toLowerCase();
            fileId = String(fileId || getFileIdFromUrl(rawUrl) || '');

            let kind = inferFileKind({ filename: name, url: rawUrl, mime });
            const videoContext = pathSuggestsVideo(path) || Object.keys(node).some(key => /video|stream|playback|hls/i.test(key));

            if (kind === 'other' && videoContext && (rawUrl || fileId)) {
                kind = rawUrl && /\.m3u8(?:$|[?#])/i.test(rawUrl) ? 'stream' : 'video';
                if (!mime && kind === 'video') mime = 'video/unknown';
            }

            const meaningfulSignal =
                Boolean(rawUrl && (looksLikeFileUrl(rawUrl, mime) || kind !== 'other')) ||
                Boolean(fileId && (isUserFacingFilename(name, kind) || videoContext));

            if (meaningfulSignal && (pathSuggestsAttachment(path) || kind !== 'other' || isUserFacingFilename(name, kind))) {
                recordInternalFile({
                    fileId,
                    url: rawUrl,
                    name,
                    mime,
                    source: 'json-response'
                });
            }

            for (const [key, value] of Object.entries(node)) {
                if (value && typeof value === 'object') {
                    visit(value, `${path}.${key}`, depth + 1);
                }
            }
        }

        visit(payload, responseUrl || 'response', 0);
    }

    // =====================================================================
    // STORAGE
    // =====================================================================
    function saveExamState() {
        try {
            GM_setValue(CONFIG.STORAGE.EXAM, JSON.stringify(DATA));
        } catch (error) {
            warn('Could not save exam state', error);
        }
    }

    function loadExamState() {
        const saved = GM_getValue(CONFIG.STORAGE.EXAM, null);
        if (!saved) return;
        const parsed = safeJsonParse(saved);
        if (!parsed || typeof parsed !== 'object') return;

        Object.assign(DATA, parsed);
    }

    function getMenuState() {
        const fallback = {
            minimized: false,
            left: null,
            top: 80
        };
        const saved = safeJsonParse(GM_getValue(CONFIG.STORAGE.MENU, ''), null);
        return saved && typeof saved === 'object'
            ? { ...fallback, ...saved }
            : fallback;
    }

    function saveMenuState(next) {
        try {
            GM_setValue(CONFIG.STORAGE.MENU, JSON.stringify(next));
        } catch {
            // UI persistence is optional.
        }
    }

    // =====================================================================
    // EXAM PROCESSING
    // =====================================================================
    function extractQuestionsPayload(data) {
        if (!data || typeof data !== 'object') return null;

        const candidates = [];
        if (Array.isArray(data.data)) candidates.push(...data.data);
        else if (data.data && typeof data.data === 'object') candidates.push(data.data);
        candidates.push(data);

        for (const candidate of candidates) {
            if (!candidate || typeof candidate !== 'object') continue;

            for (const field of ['test', 'questions', 'question_list', 'questionList']) {
                if (Array.isArray(candidate[field]) && candidate[field].length) {
                    return {
                        questions: candidate[field],
                        testId: candidate.id ?? candidate.test_id ?? candidate.testId ?? null
                    };
                }
            }
        }

        return null;
    }

    function normalizeQuestion(question, index) {
        const q = question || {};
        const optionsRaw =
            q.answer_option ||
            q.answerOptions ||
            q.options ||
            q.answers ||
            [];

        return {
            index: index + 1,
            question: cleanHtml(
                q.question_direction ??
                q.questionDirection ??
                q.question ??
                q.content ??
                q.title ??
                ''
            ),
            options: Array.isArray(optionsRaw)
                ? optionsRaw.map((option, optionIndex) => ({
                    id: String(
                        option?.id ??
                        option?.answer_id ??
                        option?.answerId ??
                        optionIndex
                    ),
                    value: cleanHtml(
                        option?.value ??
                        option?.content ??
                        option?.text ??
                        option?.label ??
                        ''
                    )
                }))
                : []
        };
    }

    function processQuestions(questions, testId) {
        if (!Array.isArray(questions) || !questions.length) return;

        const nextTestId = testId !== null && testId !== undefined
            ? String(testId)
            : null;

        const oldIds = Object.keys(DATA.questions).sort().join('|');
        const newIds = questions.map((q, i) => String(q?.id ?? i)).sort().join('|');
        const isDifferentTest =
            (nextTestId && String(DATA.testId ?? '') !== nextTestId) ||
            (!nextTestId && oldIds && oldIds !== newIds);

        if (isDifferentTest) {
            DATA.userAnswers = {};
            DATA.score = null;
        }

        DATA.questions = {};
        DATA.testId = nextTestId;
        DATA.timestamp = new Date().toLocaleString('vi-VN');
        DATA.captured = true;

        questions.forEach((q, index) => {
            const qId = String(q?.id ?? index);
            DATA.questions[qId] = normalizeQuestion(q, index);
        });

        saveExamState();
        renderMenu();

        log(`Captured ${questions.length} questions`, {
            testId: DATA.testId
        });

        notify(`Đã bắt được ${questions.length} câu hỏi.`);
    }

    function parseRequestBody(body) {
        if (!body) return {};

        if (typeof body === 'string') {
            const json = safeJsonParse(body, null);
            if (json !== null) return json;

            try {
                return Object.fromEntries(new URLSearchParams(body).entries());
            } catch {
                return {};
            }
        }

        if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
            return Object.fromEntries(body.entries());
        }

        if (typeof FormData !== 'undefined' && body instanceof FormData) {
            return Object.fromEntries(body.entries());
        }

        return typeof body === 'object' ? body : {};
    }

    function processScore(scoreData, requestBody) {
        const total = Number(
            scoreData.total_question ??
            scoreData.totalQuestion ??
            Object.keys(DATA.questions).length ??
            0
        );
        const value = Number(scoreData.score ?? 0);

        DATA.score = {
            value,
            passed: scoreData.passed === 1 || scoreData.passed === true,
            total,
            correct: total > 0 ? Math.round((value / 100) * total) : 0
        };
        DATA.userAnswers = parseRequestBody(requestBody);

        saveExamState();

        try {
            GM_setValue('lastScore', JSON.stringify(DATA.score));
        } catch {
            // Backward compatibility only.
        }

        renderMenu();
        log('Captured score', DATA.score);
    }

    function checkExamApiResponse(url, responseText, requestBody) {
        if (!responseText || typeof responseText !== 'string') return;

        const data = safeJsonParse(responseText, null);
        if (!data) return;

        if (
            url.includes('student-tests') ||
            url.includes('class-plan-activity')
        ) {
            const found = extractQuestionsPayload(data);
            if (found) {
                processQuestions(found.questions, found.testId);
            }
        }

        if (
            url.includes('/score/') &&
            data.code === 'success' &&
            data.score !== undefined
        ) {
            processScore(data, requestBody);
        }
    }

    // =====================================================================
    // ATTACHMENT REGISTRY
    // =====================================================================
    function recordInternalFile(input = {}) {
        const url = normalizeUrlCandidate(input.url || '');
        const fileId = String(input.fileId || getFileIdFromUrl(url) || '');
        const mime = String(input.mime || '').toLowerCase();
        const name = sanitizeFilename(input.name || getFilenameFromUrl(url), '');
        const kind = inferFileKind({ filename: name, url, mime });

        if (!url && !fileId && !name) return null;

        const urlKey = stableUrlKey(url);
        const existing =
            (fileId ? CAPTURED_BY_FILE_ID.get(fileId) : null) ||
            (urlKey ? CAPTURED_BY_URL.get(urlKey) : null) ||
            null;

        const key =
            existing?.key ||
            (fileId ? `id:${fileId}` : '') ||
            (urlKey ? `url:${urlKey}` : '') ||
            `internal:${normalizeFilenameKey(name)}`;

        const record = {
            key,
            fileId: fileId || existing?.fileId || '',
            name: name || existing?.name || '',
            url: url || existing?.url || '',
            mime: mime || existing?.mime || '',
            kind: kind !== 'other' ? kind : (existing?.kind || 'other'),
            source: input.source || existing?.source || 'network',
            capturedAt: Date.now()
        };

        INTERNAL_FILES.set(key, record);

        if (record.fileId) {
            CAPTURED_BY_FILE_ID.set(record.fileId, record);
        }
        if (record.url) {
            CAPTURED_BY_URL.set(stableUrlKey(record.url), record);
        }

        UI.lastCaptureAt = record.capturedAt;

        // Wake download resolvers immediately. This avoids waiting for a polling tick,
        // which is noticeable with video players that create their URL after a click.
        for (const listener of Array.from(INTERNAL_FILE_LISTENERS)) {
            try {
                listener(record);
            } catch {
                // A broken listener must not affect file capture.
            }
        }

        return record;
    }

    function findVisibleAttachment({ fileId = '', name = '', url = '' } = {}) {
        const nameKey = normalizeFilenameKey(name);
        const urlKey = stableUrlKey(url);

        return Array.from(ATTACHMENTS.values()).find(item => {
            if (fileId && item.fileId && String(item.fileId) === String(fileId)) return true;
            if (nameKey && normalizeFilenameKey(item.name) === nameKey) return true;

            const itemUrlKey = stableUrlKey(item.url || item.requestUrl || '');
            return Boolean(urlKey && itemUrlKey && itemUrlKey === urlKey);
        }) || null;
    }

    function registerAttachment(input = {}) {
        const rawUrl = normalizeUrlCandidate(input.url || '');
        const fileId = String(input.fileId || getFileIdFromUrl(rawUrl) || '');
        const mime = String(input.mime || '').toLowerCase();

        const internal = recordInternalFile({
            fileId,
            url: rawUrl,
            name: input.name || '',
            mime,
            source: input.source || 'attachment'
        });

        let kind = inferFileKind({
            filename: input.name || '',
            url: rawUrl,
            mime
        });
        if (kind === 'other' && internal?.kind) kind = internal.kind;

        let name = sanitizeFilename(input.name || '', '');

        // A URL path may provide a real filename, but never promote hashes/IDs to UI.
        if (!name) {
            const urlName = sanitizeFilename(getFilenameFromUrl(rawUrl), '');
            if (isUserFacingFilename(urlName, kind)) name = urlName;
        }

        if (!isUserFacingFilename(name, kind)) {
            if (input.allowGeneratedName && kind !== 'other') {
                name = friendlyUnknownFilename(kind, input.generatedSuffix || '');
            } else {
                // Technical network objects stay available internally for resolving downloads,
                // but they never become menu items.
                return null;
            }
        }

        const existing = findVisibleAttachment({
            fileId,
            name,
            url: rawUrl
        });

        const internalUrl =
            internal?.url && !isFileApiUrl(internal.url)
                ? internal.url
                : '';

        const directRawUrl =
            rawUrl && !isFileApiUrl(rawUrl)
                ? rawUrl
                : '';

        const requestUrl =
            isFileApiUrl(rawUrl)
                ? rawUrl
                : (existing?.requestUrl || '');

        const resolvedUrl =
            internalUrl ||
            directRawUrl ||
            existing?.url ||
            '';

        const canonicalKey = makeAttachmentKey({
            fileId: fileId || existing?.fileId || '',
            name,
            url: resolvedUrl || requestUrl
        });

        if (!canonicalKey) return null;

        const attachment = {
            key: canonicalKey,
            fileId: fileId || existing?.fileId || '',
            name: name || existing?.name || '',
            url: resolvedUrl,
            requestUrl,
            mime: mime || internal?.mime || existing?.mime || '',
            kind:
                kind !== 'other'
                    ? kind
                    : (internal?.kind || existing?.kind || 'other'),
            source: input.source || existing?.source || 'unknown',
            triggerElement:
                input.triggerElement ||
                existing?.triggerElement ||
                null,
            capturedAt: Date.now()
        };

        // If the same user-facing file was first registered under a weaker key,
        // remove the old alias before writing the canonical record.
        if (existing && existing.key !== canonicalKey) {
            ATTACHMENTS.delete(existing.key);
        }

        ATTACHMENTS.set(canonicalKey, attachment);
        renderMenu();
        return attachment;
    }

    function registerFromResponseMetadata(url, headers = {}) {
        const contentType = String(headers.contentType || '').toLowerCase();
        const contentDisposition = headers.contentDisposition || '';
        const filename = getFilenameFromContentDisposition(contentDisposition);

        if (!filename && !looksLikeFileUrl(url, contentType)) return;

        const internal = recordInternalFile({
            url,
            name: filename,
            mime: contentType,
            source: 'network-response'
        });

        // Only Content-Disposition with a meaningful filename is allowed to
        // surface a network response in the menu.
        const kind = internal?.kind || inferFileKind({
            filename,
            url,
            mime: contentType
        });

        if (filename && isUserFacingFilename(filename, kind)) {
            registerAttachment({
                fileId: internal?.fileId || '',
                url,
                name: filename,
                mime: contentType,
                source: 'network-response'
            });
        }
    }

    function captureAwsFileResponse(url, responseText) {
        if (!isFileApiUrl(url)) return;

        const data = safeJsonParse(responseText, null);
        if (!data || data.code !== 'success' || !data.data) return;

        const apiFileId = getFileIdFromUrl(url);
        const extracted = extractSignedFilePayload(data.data);
        const fileId = String(extracted.id || apiFileId || '');

        const internal = recordInternalFile({
            fileId,
            url: extracted.url,
            name: extracted.name,
            mime: extracted.mime,
            source: 'aws-file-api'
        });

        if (!internal) return;

        // If the API itself exposes an original readable filename, surface it.
        // Hashes, numeric IDs and storage object keys remain hidden.
        if (isUserFacingFilename(extracted.name, internal.kind)) {
            registerAttachment({
                fileId,
                url: extracted.url,
                name: extracted.name,
                mime: extracted.mime,
                source: 'aws-file-api'
            });
        }

        // Upgrade an already-visible DOM attachment that references this file ID.
        const visible = findVisibleAttachment({ fileId });
        if (visible && internal.url && !isFileApiUrl(internal.url)) {
            ATTACHMENTS.set(visible.key, {
                ...visible,
                url: internal.url,
                mime: internal.mime || visible.mime,
                kind: visible.kind !== 'other' ? visible.kind : internal.kind,
                capturedAt: Date.now()
            });
            renderMenu();
        }

        log('Captured file URL internally', {
            fileId,
            kind: internal.kind
        });
    }

    function handleTextResponse(url, responseText, requestBody) {
        checkExamApiResponse(url, responseText, requestBody);
        captureAwsFileResponse(url, responseText);
        captureAttachmentsFromJson(url, responseText);
    }

    // =====================================================================
    // NETWORK INTERCEPTORS - installed once
    // =====================================================================
    function installNetworkInterceptors() {
        installXhrInterceptor();
        installFetchInterceptor();
        installObjectUrlInterceptor();
        log('Network interceptors active');
    }

    function installXhrInterceptor() {
        const XHR = unsafeWindow.XMLHttpRequest;
        if (!XHR?.prototype || XHR.prototype.__hvuPatched) return;

        const originalOpen = XHR.prototype.open;
        const originalSend = XHR.prototype.send;

        XHR.prototype.open = function (method, url) {
            this.__hvuMeta = {
                method: String(method || 'GET'),
                url: normalizeUrlCandidate(String(url || '')),
                body: null
            };
            return originalOpen.apply(this, arguments);
        };

        XHR.prototype.send = function (body) {
            if (this.__hvuMeta) this.__hvuMeta.body = body;

            this.addEventListener('loadend', () => {
                const meta = this.__hvuMeta || {};
                const url = meta.url || '';
                if (!url || this.status < 200 || this.status >= 400) return;

                let contentType = '';
                let contentDisposition = '';
                try {
                    contentType = this.getResponseHeader('content-type') || '';
                    contentDisposition = this.getResponseHeader('content-disposition') || '';
                } catch {
                    // Some responses hide headers.
                }

                registerFromResponseMetadata(url, {
                    contentType,
                    contentDisposition
                });

                let responseText = '';
                try {
                    if (!this.responseType || this.responseType === 'text') {
                        responseText = this.responseText || '';
                    } else if (this.responseType === 'json' && this.response) {
                        responseText = JSON.stringify(this.response);
                    }
                } catch {
                    responseText = '';
                }

                if (responseText) {
                    handleTextResponse(url, responseText, meta.body);
                }

                if (this.responseType === 'blob' && isBlobLike(this.response)) {
                    const blobName = getFilenameFromContentDisposition(contentDisposition);
                    const internal = recordInternalFile({
                        url,
                        name: blobName,
                        mime: this.response.type || contentType,
                        source: 'xhr-blob'
                    });

                    if (blobName && isUserFacingFilename(blobName, internal?.kind || 'other')) {
                        registerAttachment({
                            fileId: internal?.fileId || '',
                            url,
                            name: blobName,
                            mime: this.response.type || contentType,
                            source: 'xhr-blob'
                        });
                    }
                }
            }, { once: true });

            return originalSend.apply(this, arguments);
        };

        Object.defineProperty(XHR.prototype, '__hvuPatched', {
            value: true,
            configurable: false
        });
    }

    function installFetchInterceptor() {
        if (!unsafeWindow.fetch || unsafeWindow.fetch.__hvuPatched) return;

        const originalFetch = unsafeWindow.fetch;

        const wrappedFetch = function (input, init) {
            const requestUrl =
                typeof input === 'string'
                    ? input
                    : input?.url || '';
            const url = normalizeUrlCandidate(requestUrl);
            const body = init?.body ?? null;

            return originalFetch.apply(this, arguments).then(response => {
                const finalUrl = normalizeUrlCandidate(response.url || url);
                const contentType = response.headers?.get('content-type') || '';
                const contentDisposition = response.headers?.get('content-disposition') || '';

                registerFromResponseMetadata(finalUrl, {
                    contentType,
                    contentDisposition
                });

                const shouldReadBody =
                    contentType.includes('application/json') ||
                    url.includes('student-tests') ||
                    url.includes('class-plan-activity') ||
                    url.includes('/score/') ||
                    /\/(?:api\/)?aws\/file\//i.test(url);

                if (shouldReadBody) {
                    response.clone().text()
                        .then(text => handleTextResponse(url, text, body))
                        .catch(() => {});
                }

                return response;
            });
        };

        Object.defineProperty(wrappedFetch, '__hvuPatched', {
            value: true
        });

        unsafeWindow.fetch = wrappedFetch;
    }

    function installObjectUrlInterceptor() {
        const URLObject = unsafeWindow.URL;
        if (!URLObject?.createObjectURL || URLObject.createObjectURL.__hvuPatched) return;

        const originalCreateObjectURL = URLObject.createObjectURL;

        const wrappedCreateObjectURL = function (object) {
            const url = originalCreateObjectURL.apply(this, arguments);

            if (isBlobLike(object)) {
                const kind = inferFileKind({ mime: object.type });
                if (kind !== 'other') {
                    recordInternalFile({
                        url,
                        mime: object.type,
                        source: 'blob-url'
                    });
                }
            }

            return url;
        };

        Object.defineProperty(wrappedCreateObjectURL, '__hvuPatched', {
            value: true
        });

        URLObject.createObjectURL = wrappedCreateObjectURL;
    }

    // =====================================================================
    // DOM ATTACHMENT DISCOVERY
    // =====================================================================
    function getDirectText(element) {
        return Array.from(element.childNodes || [])
            .filter(node => node.nodeType === Node.TEXT_NODE)
            .map(node => node.textContent || '')
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function getUrlFromElement(element) {
        if (!(element instanceof Element)) return '';

        const direct =
            element.getAttribute('href') ||
            element.getAttribute('src') ||
            element.getAttribute('data-url') ||
            element.getAttribute('data-src') ||
            element.getAttribute('data-file') ||
            element.getAttribute('data-download-url') ||
            '';

        if (direct) return normalizeUrlCandidate(direct);

        for (let current = element.parentElement, depth = 0;
            current && depth < 5;
            current = current.parentElement, depth += 1) {

            const linked = current.querySelector(
                'a[href], source[src], video[src], audio[src], iframe[src], embed[src], object[data], [data-url], [data-src], [data-file], [data-download-url]'
            );

            if (linked) {
                const nested =
                    linked.getAttribute('href') ||
                    linked.getAttribute('src') ||
                    linked.getAttribute('data') ||
                    linked.getAttribute('data-url') ||
                    linked.getAttribute('data-src') ||
                    linked.getAttribute('data-file') ||
                    linked.getAttribute('data-download-url') ||
                    '';

                if (nested) return normalizeUrlCandidate(nested);
            }
        }

        return '';
    }

    function getFileIdNearElement(element) {
        if (!(element instanceof Element)) return '';

        for (let current = element, depth = 0;
            current && depth < 6;
            current = current.parentElement, depth += 1) {

            // Explicit file-id attributes are the strongest signal and may contain
            // a bare number instead of /aws/file/<id>.
            for (const attr of ['data-file-id', 'data-fileid', 'data-document-id', 'data-attachment-id']) {
                const value = current.getAttribute(attr);
                if (value && /^[a-z0-9_-]+$/i.test(value.trim())) {
                    return value.trim();
                }
            }

            const attrs = [
                current.getAttribute('href'),
                current.getAttribute('data-url'),
                current.getAttribute('data-src'),
                current.getAttribute('data-file'),
                current.getAttribute('data-download-url')
            ].filter(Boolean);

            for (const value of attrs) {
                const match = String(value).match(/(?:\/file\/|file[_-]?id[=:]?)([a-z0-9_-]+)/i);
                if (match?.[1]) return match[1];
            }

            // Some LMS rows expose only data-id="123". Use it only when this
            // ancestor clearly looks like a file row, otherwise it may be a lesson id.
            const looseId = current.getAttribute('data-id');
            const classHint = String(current.className || '');
            const textHint = String(current.textContent || '').slice(0, 260);
            if (
                looseId &&
                /^\d+$/.test(looseId) &&
                (/file|attach|document|resource|tailieu|tai-lieu/i.test(classHint) || FILE_NAME_RE.test(textHint))
            ) {
                return looseId;
            }
        }

        return '';
    }

    function getMediaSourceUrl(media) {
        if (!isElementNode(media)) return '';
        if (!['VIDEO', 'AUDIO'].includes(media.tagName)) return '';

        const candidates = [
            media.currentSrc,
            media.getAttribute('src'),
            ...Array.from(media.querySelectorAll('source[src]')).map(source => source.src || source.getAttribute('src'))
        ]
            .map(normalizeUrlCandidate)
            .filter(Boolean);

        return candidates.find(url => !isFileApiUrl(url)) || candidates[0] || '';
    }

    function watchMediaElement(media) {
        if (!isElementNode(media)) return;
        if (!['VIDEO', 'AUDIO'].includes(media.tagName)) return;
        if (media.dataset.hvuMediaWatched === '1') return;

        media.dataset.hvuMediaWatched = '1';

        const refresh = () => discoverUrlElement(media);
        for (const eventName of ['loadstart', 'loadedmetadata', 'durationchange', 'canplay', 'playing']) {
            media.addEventListener(eventName, refresh, { passive: true });
        }

        refresh();
    }

    function findBestAttachmentTrigger(element) {
        if (!isElementNode(element)) return null;

        const interactive = element.closest(
            'a, button, [role="button"], [onclick], [data-file-id], [data-fileid], [data-file], [data-url], [data-download-url]'
        );
        if (interactive) return interactive;

        let fallback = element;
        for (let current = element, depth = 0;
            current && depth < 5;
            current = current.parentElement, depth += 1) {

            const textLength = String(current.textContent || '').trim().length;
            if (textLength > 900) break;

            try {
                if (getComputedStyle(current).cursor === 'pointer') return current;
            } catch {
                // Ignore style access failures.
            }

            if (
                current.querySelector?.(
                    'a[href], [data-file-id], [data-fileid], [data-file], [data-url], [data-download-url]'
                )
            ) {
                fallback = current;
                break;
            }

            fallback = current;
        }

        return fallback;
    }

    function extractFilenames(text) {
        const value = String(text || '');
        if (!value || value.length > 500) return [];

        const regex = new RegExp(FILE_NAME_RE.source, 'ig');
        const names = [];
        let match;
        while ((match = regex.exec(value)) !== null) {
            if (match[1]) names.push(sanitizeFilename(match[1]));
            if (match.index === regex.lastIndex) regex.lastIndex += 1;
        }
        return [...new Set(names)];
    }

    function discoverUrlElement(element) {
        if (!isElementNode(element)) return;

        const mediaHost =
            element.tagName === 'VIDEO' || element.tagName === 'AUDIO'
                ? element
                : element.closest('video, audio');

        if (mediaHost) watchMediaElement(mediaHost);

        const rawUrl =
            element.getAttribute('href') ||
            element.getAttribute('src') ||
            element.getAttribute('data') ||
            element.getAttribute('data-url') ||
            element.getAttribute('data-src') ||
            element.getAttribute('data-file') ||
            element.getAttribute('data-download-url') ||
            getMediaSourceUrl(mediaHost) ||
            '';

        if (!rawUrl) {
            // Some online-lesson players create their media URL only after the
            // player is initialized or the user presses play. Keep a visible
            // placeholder now so the download button can trigger/resolve it later.
            if (mediaHost) {
                const kind = mediaHost.tagName === 'VIDEO' ? 'video' : 'audio';
                const existingKey = mediaHost.dataset.hvuAttachmentKey || '';
                if (!existingKey || !ATTACHMENTS.has(existingKey)) {
                    const sameKindCount = Array.from(ATTACHMENTS.values())
                        .filter(item => item.kind === kind)
                        .length;
                    const created = registerAttachment({
                        mime: kind === 'video' ? 'video/unknown' : 'audio/unknown',
                        source: 'dom-media-placeholder',
                        triggerElement: mediaHost,
                        allowGeneratedName: true,
                        generatedSuffix: sameKindCount + 1
                    });
                    if (created) mediaHost.dataset.hvuAttachmentKey = created.key;
                }
            }
            return;
        }

        const absoluteUrl = normalizeUrlCandidate(rawUrl);
        let typeAttr =
            element.getAttribute('type') ||
            element.getAttribute('data-type') ||
            '';

        if (!typeAttr && mediaHost?.tagName === 'VIDEO') typeAttr = 'video/unknown';
        if (!typeAttr && mediaHost?.tagName === 'AUDIO') typeAttr = 'audio/unknown';

        if (!looksLikeFileUrl(absoluteUrl, typeAttr)) return;

        const fileId =
            getFileIdFromUrl(absoluteUrl) ||
            getFileIdNearElement(element);

        const internal = recordInternalFile({
            fileId,
            url: absoluteUrl,
            mime: typeAttr,
            source: mediaHost ? 'dom-media-live' : 'dom-url'
        });

        const kind = internal?.kind || inferFileKind({
            url: absoluteUrl,
            mime: typeAttr
        });

        const labelCandidates = [
            element.getAttribute('download'),
            element.getAttribute('title'),
            element.getAttribute('aria-label'),
            element.getAttribute('data-title'),
            element.getAttribute('data-name'),
            mediaHost?.getAttribute('title'),
            mediaHost?.getAttribute('aria-label'),
            getFilenameFromUrl(absoluteUrl)
        ]
            .map(value => sanitizeFilename(value, ''))
            .filter(Boolean);

        const readableName =
            labelCandidates.find(candidate => isUserFacingFilename(candidate, kind)) ||
            '';

        if (readableName) {
            registerAttachment({
                fileId,
                url: absoluteUrl,
                mime: typeAttr,
                name: readableName,
                source: 'dom-url',
                triggerElement: mediaHost || element
            });
            return;
        }

        // A visible media player is a real attachment even when its URL is a blob/hash.
        if (mediaHost && (kind === 'video' || kind === 'audio')) {
            const existing = findVisibleAttachment({
                fileId,
                url: absoluteUrl
            });
            if (existing) {
                mediaHost.dataset.hvuAttachmentKey = existing.key;
                // Upgrade a generated media item as soon as currentSrc becomes available.
                if (absoluteUrl && existing.url !== absoluteUrl) {
                    ATTACHMENTS.set(existing.key, {
                        ...existing,
                        url: absoluteUrl,
                        capturedAt: Date.now()
                    });
                    renderMenu();
                }
                return;
            }

            const sameKindCount = Array.from(ATTACHMENTS.values())
                .filter(item => item.kind === kind)
                .length;

            const created = registerAttachment({
                fileId,
                url: absoluteUrl,
                mime: typeAttr,
                source: 'dom-media',
                triggerElement: mediaHost,
                allowGeneratedName: true,
                generatedSuffix: sameKindCount + 1
            });
            if (created) mediaHost.dataset.hvuAttachmentKey = created.key;
        }
    }

    function discoverFilenameFromNode(textNode) {
        if (!textNode || textNode.nodeType !== 3) return;
        if (UI.processedTextNodes.has(textNode)) return;

        const parent = textNode.parentElement;
        if (!parent || parent.closest('#hvu-helper-host')) return;

        const filenames = extractFilenames(textNode.textContent || '');
        if (!filenames.length) return;

        const trigger = findBestAttachmentTrigger(parent) || parent;
        const url = getUrlFromElement(trigger);
        const fileId =
            getFileIdNearElement(trigger) ||
            getFileIdFromUrl(url);

        let capturedAny = false;

        for (const filename of filenames) {
            const attachment = registerAttachment({
                fileId,
                name: filename,
                url,
                source: 'dom-text-node',
                triggerElement: trigger
            });

            if (!attachment) continue;
            capturedAny = true;
            addInlineDownloadButton(trigger, attachment);
        }

        if (capturedAny) UI.processedTextNodes.add(textNode);
    }

    function discoverTextNodes(root = document) {
        const base = isDocumentNode(root) ? root.body : root;
        if (!base) return;

        if (base.nodeType === 3) {
            discoverFilenameFromNode(base);
            return;
        }

        if (!isElementNode(base)) return;
        if (base.closest?.('#hvu-helper-host')) return;

        const ownerDocument = base.ownerDocument || document;
        const NodeFilterObject = ownerDocument.defaultView?.NodeFilter || unsafeWindow.NodeFilter || window.NodeFilter;

        // TreeWalker is efficient, but some userscript/page realms expose different
        // DOM constructors. Fall back to element text scanning instead of letting
        // one missing global abort all attachment discovery.
        if (!NodeFilterObject || typeof ownerDocument.createTreeWalker !== 'function') {
            const candidates = [base, ...Array.from(base.querySelectorAll('a,button,span,p,div,td,li,label,strong,small'))];
            candidates.forEach(element => discoverTextElement(element));
            return;
        }

        const walker = ownerDocument.createTreeWalker(
            base,
            NodeFilterObject.SHOW_TEXT,
            {
                acceptNode(node) {
                    const text = String(node.textContent || '').trim();
                    if (!text || text.length > 500) return NodeFilterObject.FILTER_REJECT;
                    return FILE_NAME_RE.test(text)
                        ? NodeFilterObject.FILTER_ACCEPT
                        : NodeFilterObject.FILTER_REJECT;
                }
            }
        );

        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        nodes.forEach(discoverFilenameFromNode);
    }

    function discoverTextElement(element) {
        if (!isElementNode(element)) return;
        if (element.closest?.('#hvu-helper-host')) return;
        if (element.dataset?.hvuAttachmentProcessed === '1') return;

        const directText = getDirectText(element);
        const combinedText = String(element.textContent || '').replace(/\s+/g, ' ').trim();
        const candidateText = directText || combinedText;
        if (!candidateText || candidateText.length > 520) return;

        const filenames = extractFilenames(candidateText);
        if (!filenames.length) return;

        const trigger = findBestAttachmentTrigger(element) || element;
        const url = getUrlFromElement(trigger);
        const fileId =
            getFileIdNearElement(trigger) ||
            getFileIdFromUrl(url);

        let capturedAny = false;
        for (const filename of filenames) {
            const attachment = registerAttachment({
                fileId,
                name: filename,
                url,
                source: directText ? 'dom-text' : 'dom-nested-text',
                triggerElement: trigger
            });

            if (!attachment) continue;
            capturedAny = true;
            addInlineDownloadButton(trigger, attachment);
        }

        if (capturedAny && element.dataset) element.dataset.hvuAttachmentProcessed = '1';
    }

    function scanSubtree(root = document) {
        if (!root) return;

        const urlSelector =
            'a[href], source[src], video, audio, iframe[src], embed[src], object[data], ' +
            '[data-url], [data-src], [data-file], [data-download-url], [data-file-id], [data-fileid]';

        if (isElementNode(root) && root.matches?.(urlSelector)) {
            discoverUrlElement(root);
        }
        root.querySelectorAll?.(urlSelector).forEach(element => {
            discoverUrlElement(element);
            if (element.tagName === 'IFRAME') scanIframeElement(element);
        });

        discoverTextNodes(root);

        const textSelector = 'a, button, span, p, div, td, li, label, strong, small';
        if (isElementNode(root) && root.matches?.(textSelector)) {
            discoverTextElement(root);
        }
        root.querySelectorAll?.(textSelector).forEach(discoverTextElement);
    }

    function scanIframeElement(iframe) {
        if (!isElementNode(iframe) || iframe.tagName !== 'IFRAME') return;

        const scanFrame = () => {
            let frameDocument = null;
            try {
                frameDocument = iframe.contentDocument;
                // Accessing location forces the same-origin check now.
                void iframe.contentWindow?.location?.href;
            } catch {
                return;
            }

            if (!frameDocument?.body) return;
            scanSubtree(frameDocument);

            if (UI.frameObservers.has(frameDocument)) return;
            const observer = new MutationObserver(mutations => {
                const roots = new Set();
                for (const mutation of mutations) {
                    mutation.addedNodes.forEach(node => {
                        if (node.nodeType === 1) roots.add(node);
                        if (node.nodeType === 3 && node.parentElement) roots.add(node.parentElement);
                    });
                    if (mutation.type === 'characterData' && mutation.target?.parentElement) {
                        UI.processedTextNodes.delete(mutation.target);
                        roots.add(mutation.target.parentElement);
                    }
                }
                roots.forEach(frameRoot => scanSubtree(frameRoot));
            });
            observer.observe(frameDocument.body, { childList: true, characterData: true, subtree: true });
            UI.frameObservers.set(frameDocument, observer);
        };

        scanFrame();
        if (iframe.dataset.hvuFrameWatched !== '1') {
            iframe.dataset.hvuFrameWatched = '1';
            iframe.addEventListener('load', scanFrame, { passive: true });
        }
    }

    function scheduleDomScan(root = document) {
        clearTimeout(UI.scanTimer);
        UI.scanTimer = setTimeout(() => {
            scanSubtree(root);
        }, CONFIG.DOM_SCAN_DEBOUNCE_MS);
    }

    function startDomObserver() {
        if (!document.body || UI.observer) return;

        scanSubtree(document);

        UI.observer = new MutationObserver(mutations => {
            const roots = new Set();
            for (const mutation of mutations) {
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType === 1) roots.add(node);
                    if (node.nodeType === 3 && node.parentElement) roots.add(node.parentElement);
                });

                if (mutation.type === 'characterData' && mutation.target?.parentElement) {
                    UI.processedTextNodes.delete(mutation.target);
                    roots.add(mutation.target.parentElement);
                }
            }

            if (!roots.size) return;

            clearTimeout(UI.scanTimer);
            UI.scanTimer = setTimeout(() => {
                roots.forEach(root => scanSubtree(root));
            }, CONFIG.DOM_SCAN_DEBOUNCE_MS);
        });

        UI.observer.observe(document.body, {
            childList: true,
            characterData: true,
            subtree: true
        });
    }

    function addInlineDownloadButton(element, attachment) {
        if (!isElementNode(element)) return;
        if (element.parentElement?.querySelector(
            `.hvu-inline-download[data-hvu-key="${CSS.escape(attachment.key)}"]`
        )) {
            return;
        }

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'hvu-inline-download';
        button.dataset.hvuKey = attachment.key;
        button.textContent = `↓ ${FILE_TYPES[attachment.kind]?.label || 'Tải'}`;
        button.title = `Tải ${attachment.name}`;

        button.style.cssText = [
            'margin-left:8px',
            'padding:4px 9px',
            'border:0',
            'border-radius:7px',
            'background:#6d2540',
            'color:#fff',
            'font:600 11px/1.2 "Segoe UI",sans-serif',
            'cursor:pointer',
            'vertical-align:middle',
            'box-shadow:0 2px 8px rgba(0,0,0,.16)'
        ].join(';');

        button.addEventListener('click', async event => {
            event.preventDefault();
            event.stopPropagation();
            await downloadAttachment(attachment);
        });

        element.insertAdjacentElement('afterend', button);
    }

    // =====================================================================
    // DOWNLOAD RESOLUTION
    // =====================================================================
    function findAttachmentByName(name) {
        const needle = normalizeFilenameKey(name);
        if (!needle) return null;

        const matches = Array.from(ATTACHMENTS.values())
            .filter(item => normalizeFilenameKey(item.name) === needle)
            .sort((a, b) => b.capturedAt - a.capturedAt);

        return matches[0] || null;
    }

    function findInternalByName(name) {
        const needle = normalizeFilenameKey(name);
        if (!needle) return null;

        return Array.from(INTERNAL_FILES.values())
            .filter(item =>
                normalizeFilenameKey(item.name) === needle &&
                item.url &&
                !isFileApiUrl(item.url)
            )
            .sort((a, b) => b.capturedAt - a.capturedAt)[0] || null;
    }

    function findAttachmentByFileId(fileId) {
        return fileId ? CAPTURED_BY_FILE_ID.get(String(fileId)) || null : null;
    }

    function internalRecordMatches(record, startTime, desired = {}) {
        if (!record?.url || isFileApiUrl(record.url)) return false;
        if (record.capturedAt < startTime) return false;

        if (desired.fileId && record.fileId && String(record.fileId) === String(desired.fileId)) {
            return true;
        }

        if (
            desired.name &&
            record.name &&
            normalizeFilenameKey(record.name) === normalizeFilenameKey(desired.name)
        ) {
            return true;
        }

        if (
            desired.kind &&
            desired.kind !== 'other' &&
            record.kind === desired.kind
        ) {
            return true;
        }

        // When a click causes the AWS signed-file endpoint to answer, that fresh
        // response belongs to the active download even if the storage object has
        // no useful extension/MIME and therefore looks like "other".
        if (record.source === 'aws-file-api') return true;

        return !desired.fileId && !desired.name && (!desired.kind || desired.kind === 'other');
    }

    function waitForNewAttachment(startTime, desired = {}) {
        return new Promise(resolve => {
            let finished = false;
            let mediaTimer = null;
            let timeoutTimer = null;

            const finish = candidate => {
                if (finished) return;
                finished = true;
                INTERNAL_FILE_LISTENERS.delete(onInternalFile);
                if (mediaTimer) clearInterval(mediaTimer);
                if (timeoutTimer) clearTimeout(timeoutTimer);
                resolve(candidate || null);
            };

            const onInternalFile = record => {
                if (internalRecordMatches(record, startTime, desired)) {
                    finish(record);
                }
            };

            INTERNAL_FILE_LISTENERS.add(onInternalFile);

            // Check once immediately in case the response arrived between the click
            // and installing this listener.
            const immediate = Array.from(INTERNAL_FILES.values())
                .filter(item => internalRecordMatches(item, startTime, desired))
                .sort((a, b) => b.capturedAt - a.capturedAt)[0] || null;

            if (immediate) {
                finish(immediate);
                return;
            }

            const media =
                desired.triggerElement?.tagName === 'VIDEO' || desired.triggerElement?.tagName === 'AUDIO'
                    ? desired.triggerElement
                    : desired.triggerElement?.querySelector?.('video, audio') || null;

            if (media) {
                mediaTimer = setInterval(() => {
                    const liveUrl = getMediaSourceUrl(media);
                    if (!liveUrl || isFileApiUrl(liveUrl)) return;

                    const mime = media.tagName === 'VIDEO' ? 'video/unknown' : 'audio/unknown';
                    const record = recordInternalFile({
                        fileId: desired.fileId || getFileIdFromUrl(liveUrl),
                        url: liveUrl,
                        mime,
                        source: 'media-live-probe'
                    });

                    if (record && internalRecordMatches(record, startTime, desired)) {
                        finish(record);
                    }
                }, CONFIG.MEDIA_PROBE_INTERVAL_MS);
            }

            timeoutTimer = setTimeout(() => finish(null), CONFIG.FILE_RESOLVE_TIMEOUT_MS);
        });
    }

    async function resolveAttachmentUrl(attachment) {
        if (attachment.url && !isFileApiUrl(attachment.url)) {
            return attachment;
        }

        if (attachment.fileId) {
            const byId = findAttachmentByFileId(attachment.fileId);
            if (byId?.url && !isFileApiUrl(byId.url)) {
                return {
                    ...attachment,
                    url: byId.url,
                    mime: byId.mime || attachment.mime,
                    kind: attachment.kind !== 'other' ? attachment.kind : byId.kind
                };
            }
        }

        const internalByName = findInternalByName(attachment.name);
        if (internalByName?.url) {
            return {
                ...attachment,
                url: internalByName.url,
                mime: internalByName.mime || attachment.mime,
                kind:
                    attachment.kind !== 'other'
                        ? attachment.kind
                        : internalByName.kind
            };
        }

        const visibleByName = findAttachmentByName(attachment.name);
        if (
            visibleByName?.url &&
            !isFileApiUrl(visibleByName.url)
        ) {
            return {
                ...attachment,
                url: visibleByName.url,
                mime: visibleByName.mime || attachment.mime,
                kind:
                    attachment.kind !== 'other'
                        ? attachment.kind
                        : visibleByName.kind
            };
        }

        const trigger = attachment.triggerElement;
        if (!isElementNode(trigger)) return attachment;

        // Video/audio often already has a usable currentSrc even when no src
        // attribute is present. Taking it here makes many downloads start instantly.
        const mediaBeforeClick =
            trigger.tagName === 'VIDEO' || trigger.tagName === 'AUDIO'
                ? trigger
                : trigger.querySelector?.('video, audio') || null;
        const liveUrlBeforeClick = getMediaSourceUrl(mediaBeforeClick);
        if (liveUrlBeforeClick && !isFileApiUrl(liveUrlBeforeClick)) {
            return {
                ...attachment,
                url: liveUrlBeforeClick,
                kind: attachment.kind !== 'other'
                    ? attachment.kind
                    : inferFileKind({ url: liveUrlBeforeClick, mime: mediaBeforeClick?.tagName === 'VIDEO' ? 'video/unknown' : 'audio/unknown' })
            };
        }

        const start = Date.now();
        try {
            trigger.click();
        } catch {
            return attachment;
        }

        const captured = await waitForNewAttachment(start, {
            fileId: attachment.fileId,
            name: attachment.name,
            kind: attachment.kind,
            triggerElement: trigger
        });

        if (!captured?.url) return attachment;

        const updated = {
            ...attachment,
            url: captured.url,
            mime: captured.mime || attachment.mime,
            kind:
                attachment.kind !== 'other'
                    ? attachment.kind
                    : captured.kind,
            capturedAt: Date.now()
        };

        if (attachment.key && ATTACHMENTS.has(attachment.key)) {
            ATTACHMENTS.set(attachment.key, updated);
            renderMenu();
        }

        return updated;
    }

    function triggerBrowserDownload(url, filename) {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.rel = 'noopener';
        anchor.style.display = 'none';
        document.documentElement.appendChild(anchor);
        anchor.click();
        anchor.remove();
    }

    function downloadWithGM(url, filename) {
        return new Promise((resolve, reject) => {
            try {
                GM_download({
                    url,
                    name: filename,
                    saveAs: false,
                    onload: () => resolve(true),
                    onerror: error => reject(error),
                    ontimeout: () => reject(new Error('download timeout'))
                });
            } catch (error) {
                reject(error);
            }
        });
    }

    async function downloadAttachment(originalAttachment) {
        const attachment = await resolveAttachmentUrl(originalAttachment);

        if (!attachment?.url) {
            alert(
                `Chưa lấy được đường dẫn của "${originalAttachment.name}".\n\n` +
                'Hãy mở tệp/video một lần để hệ thống tạo liên kết tải, rồi bấm tải lại.'
            );
            return;
        }

        const kind = attachment.kind || inferFileKind(attachment);
        const filename = sanitizeFilename(
            attachment.name || friendlyUnknownFilename(kind, attachment.fileId)
        );

        if (kind === 'stream') {
            alert(
                'Video này đang được phát dưới dạng HLS (.m3u8), không phải một file video trực tiếp. ' +
                'HVU Exam Helper sẽ không giả vờ tải nó thành MP4 vì kết quả có thể chỉ là playlist.'
            );
            return;
        }

        notify(`Đang tải: ${filename}`);

        if (attachment.url.startsWith('blob:')) {
            triggerBrowserDownload(attachment.url, filename);
            return;
        }

        try {
            if (typeof GM_download === 'function') {
                await downloadWithGM(attachment.url, filename);
                return;
            }
        } catch (error) {
            warn('GM_download failed; falling back to browser download', error);
        }

        triggerBrowserDownload(attachment.url, filename);
    }

    // =====================================================================
    // WORD EXPORT
    // =====================================================================
    function ensureExamData() {
        if (Object.keys(DATA.questions).length) return true;

        loadExamState();
        return Object.keys(DATA.questions).length > 0;
    }

    function selectedAnswerIdsForQuestion(questionId) {
        const raw = DATA.userAnswers?.[questionId];
        const result = new Set();

        function visit(value) {
            if (value === null || value === undefined) return;

            if (Array.isArray(value)) {
                value.forEach(visit);
                return;
            }

            if (typeof value === 'object') {
                const keys = [
                    'answer', 'answer_id', 'answerId', 'answers',
                    'selected', 'selected_id', 'selectedId', 'value'
                ];
                let found = false;
                for (const key of keys) {
                    if (key in value) {
                        found = true;
                        visit(value[key]);
                    }
                }
                if (!found && value.id !== undefined) visit(value.id);
                return;
            }

            result.add(String(value));
        }

        visit(raw);
        return result;
    }

    function generateDocContent(includeAnswers) {
        if (!ensureExamData()) {
            alert('Không có dữ liệu đề thi. Hãy mở trang thi trước.');
            return null;
        }

        const questionsHtml = Object.entries(DATA.questions)
            .sort((a, b) => a[1].index - b[1].index)
            .map(([qId, q]) => {
                const selectedIds = includeAnswers
                    ? selectedAnswerIdsForQuestion(qId)
                    : new Set();

                const options = q.options.map((option, index) => {
                    const letter = String.fromCharCode(65 + index);
                    const selected = includeAnswers && selectedIds.has(String(option.id));

                    return `
                        <div class="option${selected ? ' selected' : ''}">
                            <b>${letter}.</b> ${escapeHtml(option.value)}
                            ${selected ? '<span class="picked">[ĐÃ CHỌN]</span>' : ''}
                        </div>`;
                }).join('');

                return `
                    <section class="question-block">
                        <div class="question-title">Câu ${q.index}</div>
                        <div class="question-text">${escapeHtml(q.question)}</div>
                        <div class="options">${options}</div>
                    </section>`;
            })
            .join('');

        return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word">
<head>
<meta charset="UTF-8">
<title>Đề thi HVU</title>
<style>
    @page { margin: 1.8cm; }
    body {
        font-family: "Times New Roman", serif;
        font-size: 12pt;
        line-height: 1.45;
        color: #111;
    }
    h1 {
        text-align: center;
        font-size: 18pt;
        margin: 0 0 16pt;
    }
    .meta {
        border: 1px solid #d9d9d9;
        background: #f7f7f7;
        padding: 10pt;
        margin-bottom: 14pt;
    }
    .meta div { margin: 2pt 0; }
    .question-block {
        margin: 0 0 16pt;
        page-break-inside: avoid;
    }
    .question-title {
        font-weight: bold;
        font-size: 12.5pt;
        margin-bottom: 4pt;
    }
    .question-text {
        font-weight: bold;
        margin-bottom: 6pt;
    }
    .option {
        margin: 3pt 0 3pt 18pt;
    }
    .selected {
        font-weight: bold;
        background: #eef7ee;
    }
    .picked {
        margin-left: 8pt;
        color: #176b2c;
        font-size: 10pt;
    }
    .footer {
        margin-top: 22pt;
        padding-top: 8pt;
        border-top: 1px solid #bbb;
        text-align: center;
        color: #666;
        font-size: 10pt;
    }
</style>
</head>
<body>
    <h1>ĐỀ THI HVU${includeAnswers ? ' + ĐÁP ÁN ĐÃ CHỌN' : ''}</h1>
    <div class="meta">
        <div><b>Thời gian:</b> ${escapeHtml(DATA.timestamp || new Date().toLocaleString('vi-VN'))}</div>
        <div><b>Mã đề:</b> ${escapeHtml(DATA.testId || 'N/A')}</div>
        <div><b>Số câu:</b> ${Object.keys(DATA.questions).length}</div>
        ${DATA.score ? `
            <div><b>Điểm:</b> ${escapeHtml(DATA.score.value)} - ${DATA.score.passed ? 'ĐẠT' : 'CHƯA ĐẠT'}</div>
        ` : ''}
    </div>
    ${questionsHtml}
    <div class="footer">
        Zalo: ${escapeHtml(CONFIG.ZALO)} | HVU Exam Helper v${escapeHtml(VERSION)}
    </div>
</body>
</html>`;
    }

    function saveTest(includeAnswers) {
        const content = generateDocContent(includeAnswers);
        if (!content) return;

        const date = new Date().toISOString().slice(0, 10);
        const idPart = DATA.testId ? `_${sanitizeFilename(DATA.testId)}` : '';
        const filename =
            `${includeAnswers ? 'DeThi_DapAn_HVU' : 'DeThi_HVU'}${idPart}_${date}.doc`;

        const blob = new Blob([content], {
            type: 'application/msword;charset=utf-8'
        });
        const url = URL.createObjectURL(blob);

        triggerBrowserDownload(url, filename);
        setTimeout(() => URL.revokeObjectURL(url), 1500);

        notify(`Đã lưu: ${filename}`);
    }


    // =====================================================================
    // UI SETTINGS
    // =====================================================================
    const UI_SETTINGS_DEFAULTS = Object.freeze({
        theme: 'hvu',
        density: 'compact',

        headerImage: '',
        headerOverlay: 46,
        headerImageX: 50,
        headerImageY: 50,

        menuImage: '',
        menuOverlay: 54,
        menuImageX: 50,
        menuImageY: 50
    });

    const UI_THEME_NAMES = Object.freeze({
        hvu: 'HVU',
        midnight: 'Midnight',
        ocean: 'Ocean',
        emerald: 'Emerald',
        violet: 'Violet',
        graphite: 'Graphite',
        light: 'Light'
    });

    function getUiSettings() {
        const raw = GM_getValue(CONFIG.STORAGE.SETTINGS, '');
        const parsed = safeJsonParse(raw, null);

        const next = {
            ...UI_SETTINGS_DEFAULTS,
            ...(parsed && typeof parsed === 'object' ? parsed : {})
        };

        if (!UI_THEME_NAMES[next.theme]) next.theme = UI_SETTINGS_DEFAULTS.theme;
        if (!['compact', 'comfortable'].includes(next.density)) {
            next.density = UI_SETTINGS_DEFAULTS.density;
        }

        next.headerOverlay = Math.max(10, Math.min(80, Number(next.headerOverlay) || 46));
        next.menuOverlay = Math.max(15, Math.min(85, Number(next.menuOverlay) || 54));

        next.headerImageX = Math.max(0, Math.min(100, Number(next.headerImageX) || 50));
        next.headerImageY = Math.max(0, Math.min(100, Number(next.headerImageY) || 50));
        next.menuImageX = Math.max(0, Math.min(100, Number(next.menuImageX) || 50));
        next.menuImageY = Math.max(0, Math.min(100, Number(next.menuImageY) || 50));

        next.headerImage = typeof next.headerImage === 'string' ? next.headerImage : '';
        next.menuImage = typeof next.menuImage === 'string' ? next.menuImage : '';

        return next;
    }

    function saveUiSettings(next) {
        const normalized = {
            ...getUiSettings(),
            ...next
        };

        try {
            GM_setValue(CONFIG.STORAGE.SETTINGS, JSON.stringify(normalized));
        } catch (error) {
            warn('Could not save UI settings', error);
        }

        applyUiSettings(normalized);
        return normalized;
    }

    function applyUiSettings(settings = getUiSettings()) {
        if (!UI.shadow || !UI.host) return;

        const panel = UI.shadow.getElementById('panel');

        const header = UI.shadow.getElementById('dragHandle');
        const headerMedia = UI.shadow.getElementById('headerMedia');
        const headerShade = UI.shadow.getElementById('headerShade');
        const headerPreview = UI.shadow.getElementById('headerPreview');
        const headerOverlayInput = UI.shadow.getElementById('headerOverlay');
        const headerOverlayValue = UI.shadow.getElementById('headerOverlayValue');
        const headerPositionValue = UI.shadow.getElementById('headerPositionValue');

        const panelMedia = UI.shadow.getElementById('panelMedia');
        const panelShade = UI.shadow.getElementById('panelShade');
        const menuPreview = UI.shadow.getElementById('menuPreview');
        const menuOverlayInput = UI.shadow.getElementById('menuOverlay');
        const menuOverlayValue = UI.shadow.getElementById('menuOverlayValue');
        const menuPositionValue = UI.shadow.getElementById('menuPositionValue');

        if (panel) panel.dataset.theme = settings.theme;
        UI.host.dataset.density = settings.density;

        UI.shadow.querySelectorAll('[data-theme-option]').forEach(button => {
            button.classList.toggle(
                'active',
                button.getAttribute('data-theme-option') === settings.theme
            );
        });

        UI.shadow.querySelectorAll('[data-density-option]').forEach(button => {
            button.classList.toggle(
                'active',
                button.getAttribute('data-density-option') === settings.density
            );
        });

        if (headerOverlayInput) headerOverlayInput.value = String(settings.headerOverlay);
        if (headerOverlayValue) headerOverlayValue.textContent = `${settings.headerOverlay}%`;
        if (menuOverlayInput) menuOverlayInput.value = String(settings.menuOverlay);
        if (menuOverlayValue) menuOverlayValue.textContent = `${settings.menuOverlay}%`;

        if (headerPositionValue) {
            headerPositionValue.textContent =
                `X ${Math.round(settings.headerImageX)}% · Y ${Math.round(settings.headerImageY)}%`;
        }

        if (menuPositionValue) {
            menuPositionValue.textContent =
                `X ${Math.round(settings.menuImageX)}% · Y ${Math.round(settings.menuImageY)}%`;
        }

        if (settings.headerImage) {
            const safeImage = settings.headerImage.replace(/"/g, '%22');

            header?.classList.add('has-image');

            if (headerMedia) {
                headerMedia.style.backgroundImage = `url("${safeImage}")`;
                headerMedia.style.backgroundPosition =
                    `${settings.headerImageX}% ${settings.headerImageY}%`;
            }

            if (headerShade) {
                headerShade.style.background =
                    `rgba(3, 7, 18, ${Math.max(.1, Math.min(.8, settings.headerOverlay / 100))})`;
            }

            if (headerPreview) {
                headerPreview.classList.add('has-image');
                headerPreview.style.backgroundImage = `url("${safeImage}")`;
                headerPreview.style.backgroundPosition =
                    `${settings.headerImageX}% ${settings.headerImageY}%`;
            }
        } else {
            header?.classList.remove('has-image');

            if (headerMedia) headerMedia.style.backgroundImage = 'none';
            if (headerShade) headerShade.style.background = 'transparent';

            if (headerPreview) {
                headerPreview.classList.remove('has-image');
                headerPreview.style.backgroundImage = 'none';
            }
        }

        if (settings.menuImage) {
            const safeImage = settings.menuImage.replace(/"/g, '%22');

            panel?.classList.add('has-menu-image');

            if (panelMedia) {
                panelMedia.style.backgroundImage = `url("${safeImage}")`;
                panelMedia.style.backgroundPosition =
                    `${settings.menuImageX}% ${settings.menuImageY}%`;
            }

            if (panelShade) {
                panelShade.style.background =
                    `rgba(3, 7, 18, ${Math.max(.15, Math.min(.85, settings.menuOverlay / 100))})`;
            }

            if (menuPreview) {
                menuPreview.classList.add('has-image');
                menuPreview.style.backgroundImage = `url("${safeImage}")`;
                menuPreview.style.backgroundPosition =
                    `${settings.menuImageX}% ${settings.menuImageY}%`;
            }
        } else {
            panel?.classList.remove('has-menu-image');

            if (panelMedia) panelMedia.style.backgroundImage = 'none';
            if (panelShade) panelShade.style.background = 'transparent';

            if (menuPreview) {
                menuPreview.classList.remove('has-image');
                menuPreview.style.backgroundImage = 'none';
            }
        }
    }

    function readAndOptimizeUiImage(file) {
        return new Promise((resolve, reject) => {
            if (!file || !file.type?.startsWith('image/')) {
                reject(new Error('Vui lòng chọn một tệp ảnh.'));
                return;
            }

            if (file.size > 8 * 1024 * 1024) {
                reject(new Error('Ảnh quá lớn. Hãy chọn ảnh nhỏ hơn 8 MB.'));
                return;
            }

            const reader = new FileReader();

            reader.onerror = () => reject(new Error('Không thể đọc ảnh.'));
            reader.onload = () => {
                const image = new Image();

                image.onerror = () => reject(new Error('Ảnh không hợp lệ.'));
                image.onload = () => {
                    try {
                        const MAX_WIDTH = 1200;
                        const MAX_HEIGHT = 500;
                        const scale = Math.min(
                            1,
                            MAX_WIDTH / Math.max(1, image.naturalWidth),
                            MAX_HEIGHT / Math.max(1, image.naturalHeight)
                        );

                        const width = Math.max(1, Math.round(image.naturalWidth * scale));
                        const height = Math.max(1, Math.round(image.naturalHeight * scale));

                        const canvas = document.createElement('canvas');
                        canvas.width = width;
                        canvas.height = height;

                        const ctx = canvas.getContext('2d', { alpha: false });
                        if (!ctx) throw new Error('Không thể xử lý ảnh.');

                        ctx.fillStyle = '#0f172a';
                        ctx.fillRect(0, 0, width, height);
                        ctx.drawImage(image, 0, 0, width, height);

                        let dataUrl = '';
                        try {
                            dataUrl = canvas.toDataURL('image/webp', 0.84);
                        } catch {
                            dataUrl = canvas.toDataURL('image/jpeg', 0.84);
                        }

                        if (!dataUrl || dataUrl === 'data:,') {
                            throw new Error('Không thể nén ảnh.');
                        }

                        resolve(dataUrl);
                    } catch (error) {
                        reject(error);
                    }
                };

                image.src = String(reader.result || '');
            };

            reader.readAsDataURL(file);
        });
    }

    function bindImagePositionDrag(preview, imageKey, xKey, yKey) {
        if (!preview) return;

        let dragging = false;
        let pointerId = null;
        let draftX = 50;
        let draftY = 50;

        const updateFromPointer = event => {
            const rect = preview.getBoundingClientRect();
            if (!rect.width || !rect.height) return;

            draftX = Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100));
            draftY = Math.max(0, Math.min(100, ((event.clientY - rect.top) / rect.height) * 100));

            preview.style.backgroundPosition = `${draftX}% ${draftY}%`;

            const valueId =
                imageKey === 'headerImage'
                    ? 'headerPositionValue'
                    : 'menuPositionValue';

            const value = UI.shadow?.getElementById(valueId);
            if (value) {
                value.textContent = `X ${Math.round(draftX)}% · Y ${Math.round(draftY)}%`;
            }
        };

        preview.addEventListener('pointerdown', event => {
            const settings = getUiSettings();
            if (!settings[imageKey]) return;

            dragging = true;
            pointerId = event.pointerId;
            draftX = Number(settings[xKey]) || 50;
            draftY = Number(settings[yKey]) || 50;

            preview.classList.add('dragging');
            preview.setPointerCapture?.(pointerId);
            updateFromPointer(event);
            event.preventDefault();
        });

        preview.addEventListener('pointermove', event => {
            if (!dragging || event.pointerId !== pointerId) return;
            updateFromPointer(event);
            event.preventDefault();
        });

        const finish = event => {
            if (!dragging || (event && event.pointerId !== pointerId)) return;
            dragging = false;

            try {
                preview.releasePointerCapture?.(pointerId);
            } catch {}

            preview.classList.remove('dragging');

            saveUiSettings({
                [xKey]: draftX,
                [yKey]: draftY
            });

            pointerId = null;
        };

        preview.addEventListener('pointerup', finish);
        preview.addEventListener('pointercancel', finish);
    }

    function bindSettingsUi() {
        if (!UI.shadow) return;

        const panel = UI.shadow.getElementById('panel');
        const settingsBtn = UI.shadow.getElementById('settingsBtn');
        const settingsBack = UI.shadow.getElementById('settingsBack');
        const resetBtn = UI.shadow.getElementById('resetAppearance');

        const headerImageInput = UI.shadow.getElementById('headerImageInput');
        const chooseHeaderImage = UI.shadow.getElementById('chooseHeaderImage');
        const removeHeaderImage = UI.shadow.getElementById('removeHeaderImage');
        const headerOverlayInput = UI.shadow.getElementById('headerOverlay');
        const headerPreview = UI.shadow.getElementById('headerPreview');

        const menuImageInput = UI.shadow.getElementById('menuImageInput');
        const chooseMenuImage = UI.shadow.getElementById('chooseMenuImage');
        const removeMenuImage = UI.shadow.getElementById('removeMenuImage');
        const menuOverlayInput = UI.shadow.getElementById('menuOverlay');
        const menuPreview = UI.shadow.getElementById('menuPreview');

        const openSettings = () => {
            panel?.classList.add('settings-open');
            applyUiSettings(getUiSettings());
        };

        const closeSettings = () => {
            panel?.classList.remove('settings-open');
        };

        settingsBtn?.addEventListener('click', event => {
            event.stopPropagation();
            openSettings();
        });

        settingsBack?.addEventListener('click', closeSettings);

        UI.shadow.querySelectorAll('[data-theme-option]').forEach(button => {
            button.addEventListener('click', () => {
                saveUiSettings({
                    theme: button.getAttribute('data-theme-option') || 'hvu'
                });
            });
        });

        UI.shadow.querySelectorAll('[data-density-option]').forEach(button => {
            button.addEventListener('click', () => {
                saveUiSettings({
                    density: button.getAttribute('data-density-option') || 'compact'
                });
            });
        });

        chooseHeaderImage?.addEventListener('click', () => headerImageInput?.click());

        headerImageInput?.addEventListener('change', async () => {
            const file = headerImageInput.files?.[0];
            if (!file) return;

            const originalText = chooseHeaderImage?.textContent || 'Chọn ảnh';

            if (chooseHeaderImage) {
                chooseHeaderImage.disabled = true;
                chooseHeaderImage.textContent = 'Đang xử lý...';
            }

            try {
                const dataUrl = await readAndOptimizeUiImage(file);

                saveUiSettings({
                    headerImage: dataUrl,
                    headerImageX: 50,
                    headerImageY: 50
                });

                notify('Đã đặt ảnh nền tiêu đề.');
            } catch (error) {
                alert(error?.message || 'Không thể xử lý ảnh.');
            } finally {
                if (chooseHeaderImage) {
                    chooseHeaderImage.disabled = false;
                    chooseHeaderImage.textContent = originalText;
                }

                headerImageInput.value = '';
            }
        });

        removeHeaderImage?.addEventListener('click', () => {
            saveUiSettings({
                headerImage: '',
                headerImageX: 50,
                headerImageY: 50
            });
        });

        chooseMenuImage?.addEventListener('click', () => menuImageInput?.click());

        menuImageInput?.addEventListener('change', async () => {
            const file = menuImageInput.files?.[0];
            if (!file) return;

            const originalText = chooseMenuImage?.textContent || 'Chọn ảnh';

            if (chooseMenuImage) {
                chooseMenuImage.disabled = true;
                chooseMenuImage.textContent = 'Đang xử lý...';
            }

            try {
                const dataUrl = await readAndOptimizeUiImage(file);

                saveUiSettings({
                    menuImage: dataUrl,
                    menuImageX: 50,
                    menuImageY: 50
                });

                notify('Đã đặt ảnh nền menu.');
            } catch (error) {
                alert(error?.message || 'Không thể xử lý ảnh.');
            } finally {
                if (chooseMenuImage) {
                    chooseMenuImage.disabled = false;
                    chooseMenuImage.textContent = originalText;
                }

                menuImageInput.value = '';
            }
        });

        removeMenuImage?.addEventListener('click', () => {
            saveUiSettings({
                menuImage: '',
                menuImageX: 50,
                menuImageY: 50
            });
        });

        headerOverlayInput?.addEventListener('input', () => {
            const value = Number(headerOverlayInput.value || 46);
            const current = getUiSettings();

            const label = UI.shadow?.getElementById('headerOverlayValue');
            const shade = UI.shadow?.getElementById('headerShade');

            if (label) label.textContent = `${value}%`;

            if (shade && current.headerImage) {
                shade.style.background =
                    `rgba(3, 7, 18, ${Math.max(.1, Math.min(.8, value / 100))})`;
            }
        });

        headerOverlayInput?.addEventListener('change', () => {
            saveUiSettings({
                headerOverlay: Number(headerOverlayInput.value || 46)
            });
        });

        menuOverlayInput?.addEventListener('input', () => {
            const value = Number(menuOverlayInput.value || 54);
            const current = getUiSettings();

            const label = UI.shadow?.getElementById('menuOverlayValue');
            const shade = UI.shadow?.getElementById('panelShade');

            if (label) label.textContent = `${value}%`;

            if (shade && current.menuImage) {
                shade.style.background =
                    `rgba(3, 7, 18, ${Math.max(.15, Math.min(.85, value / 100))})`;
            }
        });

        menuOverlayInput?.addEventListener('change', () => {
            saveUiSettings({
                menuOverlay: Number(menuOverlayInput.value || 54)
            });
        });

        bindImagePositionDrag(
            headerPreview,
            'headerImage',
            'headerImageX',
            'headerImageY'
        );

        bindImagePositionDrag(
            menuPreview,
            'menuImage',
            'menuImageX',
            'menuImageY'
        );

        resetBtn?.addEventListener('click', () => {
            try {
                GM_setValue(
                    CONFIG.STORAGE.SETTINGS,
                    JSON.stringify(UI_SETTINGS_DEFAULTS)
                );
            } catch {}

            applyUiSettings(UI_SETTINGS_DEFAULTS);
        });
    }

    // =====================================================================
    // MENU UI
    // =====================================================================
    function createFloatingMenu() {
        if (!document.body || document.getElementById('hvu-helper-host')) return;

        const host = document.createElement('div');
        host.id = 'hvu-helper-host';

        const shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = `
<style>
    :host {
        all: initial;
        position: fixed;
        top: 80px;
        right: 16px;
        width: 302px;
        max-width: calc(100vw - 20px);
        z-index: 2147483647;
        font-family: Inter, "Segoe UI", Arial, sans-serif;
        -webkit-font-smoothing: antialiased;
        color: var(--text);
    }

    :host([data-density="comfortable"]) {
        width: 324px;
    }

    * { box-sizing: border-box; }

    .panel {
        --bg: #25111a;
        --surface: #30151f;
        --surface-2: #3b1926;
        --surface-hover: #472030;
        --border: rgba(255,255,255,.09);
        --border-strong: rgba(255,255,255,.15);
        --text: #fff7fa;
        --muted: #c4aab4;
        --muted-2: #987b86;
        --accent: #ef3f70;
        --accent-2: #ff7899;
        --accent-soft: rgba(239,63,112,.14);
        --success: #45c97a;
        --warning: #f5a524;
        --shadow: 0 18px 42px rgba(16,6,10,.30);

        overflow: hidden;
        border: 1px solid var(--border);
        border-radius: 14px;
        background: var(--bg);
        box-shadow: var(--shadow);
        color: var(--text);
        transition:
            width .18s ease,
            background .18s ease,
            border-color .18s ease,
            box-shadow .18s ease;
        position: relative;
        isolation: isolate;
        transform-origin: top right;
        animation: hvuPanelEnter .30s cubic-bezier(.2,.8,.2,1) both;
    }

    .panel-media,
    .panel-shade {
        position: absolute;
        inset: 0;
        pointer-events: none;
    }

    .panel-media {
        z-index: -2;
        background-size: cover;
        background-repeat: no-repeat;
        opacity: 0;
        transform: scale(1.01);
    }

    .panel-shade {
        z-index: -1;
        background: transparent;
    }

    .panel.has-menu-image {
        background: transparent;
        --text: #ffffff;
        --muted: #d8dee8;
        --muted-2: #aab4c2;
        --border: rgba(255,255,255,.14);
        --border-strong: rgba(255,255,255,.22);
    }

    .panel.has-menu-image .panel-media {
        opacity: 1;
    }

    .panel.has-menu-image .body,
    .panel.has-menu-image .settings-screen {
        background: rgba(6, 10, 18, .12);
    }

    .panel.has-menu-image .status,
    .panel.has-menu-image .stat,
    .panel.has-menu-image .secondary,
    .panel.has-menu-image .file,
    .panel.has-menu-image .empty,
    .panel.has-menu-image .theme-option,
    .panel.has-menu-image .segmented,
    .panel.has-menu-image .settings-button,
    .panel.has-menu-image .settings-back {
        background: rgba(9, 15, 25, .48);
        backdrop-filter: blur(5px);
    }

    .panel[data-theme="midnight"] {
        --bg: #0b1220;
        --surface: #111b2d;
        --surface-2: #162238;
        --surface-hover: #1c2b45;
        --border: rgba(148,163,184,.14);
        --border-strong: rgba(148,163,184,.24);
        --text: #f8fafc;
        --muted: #a7b4c8;
        --muted-2: #718096;
        --accent: #4f7cff;
        --accent-2: #7aa2ff;
        --accent-soft: rgba(79,124,255,.14);
        --shadow: 0 18px 42px rgba(2,6,23,.34);
    }

    .panel[data-theme="ocean"] {
        --bg: #082331;
        --surface: #0b3042;
        --surface-2: #0e3c51;
        --surface-hover: #124960;
        --border: rgba(165,243,252,.12);
        --border-strong: rgba(165,243,252,.22);
        --text: #ecfeff;
        --muted: #a5d7df;
        --muted-2: #6ba9b5;
        --accent: #06b6d4;
        --accent-2: #22d3ee;
        --accent-soft: rgba(6,182,212,.14);
        --shadow: 0 18px 42px rgba(4,33,45,.32);
    }

    .panel[data-theme="emerald"] {
        --bg: #09251e;
        --surface: #0d3329;
        --surface-2: #104034;
        --surface-hover: #15503f;
        --border: rgba(167,243,208,.12);
        --border-strong: rgba(167,243,208,.22);
        --text: #ecfdf5;
        --muted: #a7d7c5;
        --muted-2: #6ca58f;
        --accent: #10b981;
        --accent-2: #34d399;
        --accent-soft: rgba(16,185,129,.14);
        --shadow: 0 18px 42px rgba(4,38,29,.32);
    }

    .panel[data-theme="violet"] {
        --bg: #1d1533;
        --surface: #281b45;
        --surface-2: #342255;
        --surface-hover: #412b67;
        --border: rgba(221,214,254,.12);
        --border-strong: rgba(221,214,254,.22);
        --text: #faf5ff;
        --muted: #c9b7e5;
        --muted-2: #947eaf;
        --accent: #9b5de5;
        --accent-2: #c084fc;
        --accent-soft: rgba(155,93,229,.14);
        --shadow: 0 18px 42px rgba(26,15,49,.32);
    }

    .panel[data-theme="graphite"] {
        --bg: #18191c;
        --surface: #212328;
        --surface-2: #292c32;
        --surface-hover: #33363d;
        --border: rgba(255,255,255,.09);
        --border-strong: rgba(255,255,255,.16);
        --text: #f4f4f5;
        --muted: #b2b3b8;
        --muted-2: #7d7f86;
        --accent: #f97316;
        --accent-2: #fb923c;
        --accent-soft: rgba(249,115,22,.13);
        --shadow: 0 18px 42px rgba(0,0,0,.32);
    }

    .panel[data-theme="light"] {
        --bg: #ffffff;
        --surface: #f7f8fa;
        --surface-2: #eef1f5;
        --surface-hover: #e8ecf2;
        --border: rgba(15,23,42,.10);
        --border-strong: rgba(15,23,42,.17);
        --text: #172033;
        --muted: #687386;
        --muted-2: #929bad;
        --accent: #e11d48;
        --accent-2: #f43f5e;
        --accent-soft: rgba(225,29,72,.08);
        --success: #16a34a;
        --warning: #d97706;
        --shadow: 0 16px 38px rgba(15,23,42,.14);
    }

    button, a, input {
        font: inherit;
    }

    .header {
        position: relative;
        z-index: 2;
        isolation: isolate;
        min-height: 52px;
        display: flex;
        align-items: center;
        gap: 9px;
        padding: 8px 9px;
        overflow: hidden;
        cursor: grab;
        touch-action: none;
        border-bottom: 1px solid var(--border);
        background: var(--surface);
    }

    .header:active { cursor: grabbing; }

    .header-media,
    .header-shade {
        position: absolute;
        inset: 0;
        pointer-events: none;
    }

    .header-media {
        z-index: -2;
        background-size: cover;
        background-repeat: no-repeat;
        opacity: 0;
        transform: scale(1.01);
    }

    .header-shade {
        z-index: -1;
        background: transparent;
    }

    .header.has-image .header-media {
        opacity: 1;
    }

    .header.has-image {
        border-bottom-color: rgba(255,255,255,.10);
    }

    .header.has-image .title,
    .header.has-image .subtitle,
    .header.has-image .version {
        color: #fff;
        text-shadow: 0 1px 5px rgba(0,0,0,.65);
    }

    .header.has-image .icon-btn {
        color: #fff;
        border-color: rgba(255,255,255,.20);
        background: rgba(0,0,0,.22);
    }

    .logo {
        width: 31px;
        height: 31px;
        flex: 0 0 auto;
        display: grid;
        place-items: center;
        border-radius: 9px;
        color: white;
        background: linear-gradient(145deg, var(--accent-2), var(--accent));
        box-shadow: 0 5px 14px color-mix(in srgb, var(--accent) 26%, transparent);
        font-size: 12.4px;
        font-weight: 900;
        letter-spacing: -.35px;
    }

    .title-wrap {
        min-width: 0;
        flex: 1;
    }

    .title-row {
        display: flex;
        align-items: baseline;
        gap: 6px;
        min-width: 0;
    }

    .title {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--text);
        font-size: 13.5px;
        line-height: 1.15;
        font-weight: 800;
    }

    .version {
        flex: 0 0 auto;
        color: var(--muted);
        font-size: 10.2px;
        font-weight: 700;
    }

    .subtitle {
        margin-top: 2px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--muted);
        font-size: 9.6px;
    }

    .header-actions {
        display: flex;
        gap: 4px;
        flex: 0 0 auto;
    }

    .icon-btn {
        width: 27px;
        height: 27px;
        display: grid;
        place-items: center;
        border: 1px solid var(--border);
        border-radius: 8px;
        color: var(--muted);
        background: rgba(255,255,255,.035);
        cursor: pointer;
        line-height: 1;
        transition:
            color .16s ease,
            background .16s ease,
            border-color .16s ease,
            transform .16s cubic-bezier(.2,.8,.2,1),
            box-shadow .16s ease;
    }

    .icon-btn:hover {
        color: var(--text);
        border-color: var(--border-strong);
        background: var(--surface-hover);
        transform: translateY(-1px);
        box-shadow: 0 4px 10px rgba(0,0,0,.10);
    }

    .icon-btn:active {
        transform: translateY(0) scale(.92);
    }

    .header-icon {
        width: 14px;
        height: 14px;
        display: block;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.8;
        stroke-linecap: round;
        stroke-linejoin: round;
        pointer-events: none;
    }

    .collapse-icon {
        transition: transform .28s cubic-bezier(.2,.8,.2,1);
        transform-origin: 50% 50%;
    }

    .panel.minimized .collapse-icon {
        transform: rotate(180deg);
    }

    .body {
        position: relative;
        z-index: 1;
        padding: 9px;
    }

    :host([data-density="comfortable"]) .body {
        padding: 11px;
    }

    .content-shell {
        position: relative;
        z-index: 1;
        max-height: 620px;
        overflow: hidden;
        opacity: 1;
        transform: translateY(0);
        transition:
            max-height .34s cubic-bezier(.2,.8,.2,1),
            opacity .22s ease,
            transform .28s cubic-bezier(.2,.8,.2,1);
    }

    .panel.minimized .content-shell {
        max-height: 0;
        opacity: 0;
        transform: translateY(-6px);
        pointer-events: none;
    }

    .panel.minimized .header {
        border-bottom-color: transparent;
    }

    .panel.settings-open .main-screen {
        display: none;
    }

    .main-screen {
        animation: hvuContentEnter .23s cubic-bezier(.2,.8,.2,1) both;
    }

    .settings-screen {
        position: relative;
        z-index: 1;
        display: none;
        max-height: min(470px, calc(100vh - 90px));
        overflow-y: auto;
        padding: 9px;
    }

    .panel.settings-open .settings-screen {
        display: block;
        animation: hvuSettingsEnter .24s cubic-bezier(.2,.8,.2,1) both;
    }

    .settings-screen::-webkit-scrollbar,
    .files::-webkit-scrollbar {
        width: 5px;
    }

    .settings-screen::-webkit-scrollbar-thumb,
    .files::-webkit-scrollbar-thumb {
        border-radius: 999px;
        background: color-mix(in srgb, var(--muted) 25%, transparent);
    }

    .status {
        min-height: 34px;
        display: flex;
        align-items: center;
        gap: 7px;
        margin-bottom: 8px;
        padding: 7px 8px;
        border: 1px solid var(--border);
        border-radius: 9px;
        color: var(--muted);
        background: var(--surface);
        font-size: 10.6px;
    }

    .dot {
        position: relative;
        width: 7px;
        height: 7px;
        flex: 0 0 auto;
        border-radius: 50%;
        background: var(--warning);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--warning) 12%, transparent);
    }

    .dot::after {
        content: "";
        position: absolute;
        inset: -4px;
        border: 1px solid color-mix(in srgb, var(--warning) 38%, transparent);
        border-radius: 50%;
        animation: hvuStatusPulse 1.8s ease-out infinite;
    }

    .status.ready .dot {
        background: var(--success);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--success) 12%, transparent);
    }

    .status.ready .dot::after {
        border-color: color-mix(in srgb, var(--success) 34%, transparent);
    }

    .stats {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 6px;
        margin-bottom: 8px;
    }

    .stat {
        min-width: 0;
        padding: 7px 7px 6px;
        border: 1px solid var(--border);
        border-radius: 9px;
        background: var(--surface);
    }

    .stat-label {
        margin-bottom: 2px;
        color: var(--muted);
        font-size: 10.2px;
    }

    .stat-value {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--text);
        font-size: 13.5px;
        font-weight: 800;
    }

    .actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
        margin-bottom: 9px;
    }

    .action-btn {
        min-height: 34px;
        border-radius: 9px;
        cursor: pointer;
        font-size: 10.7px;
        font-weight: 800;
        transition: .15s ease;
    }

    .action-btn:hover {
        transform: translateY(-1px);
    }

    .action-btn:active {
        transform: translateY(0) scale(.975);
    }

    .primary {
        border: 1px solid transparent;
        color: #fff;
        background: linear-gradient(135deg, var(--accent-2), var(--accent));
        box-shadow: 0 6px 14px color-mix(in srgb, var(--accent) 16%, transparent);
    }

    .secondary {
        border: 1px solid var(--border);
        color: var(--text);
        background: var(--surface);
    }

    .secondary:hover {
        border-color: var(--border-strong);
        background: var(--surface-hover);
    }

    .section-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin: 1px 1px 6px;
    }

    .section-title {
        color: var(--text);
        font-size: 10.2px;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: .55px;
    }

    .section-count {
        padding: 2px 6px;
        border-radius: 999px;
        color: var(--muted);
        background: var(--surface);
        font-size: 10px;
    }

    .files {
        display: flex;
        flex-direction: column;
        gap: 5px;
        max-height: 166px;
        overflow-y: auto;
        padding-right: 2px;
    }

    :host([data-density="comfortable"]) .files {
        max-height: 196px;
    }

    .empty {
        padding: 11px 9px;
        border: 1px dashed var(--border-strong);
        border-radius: 9px;
        color: var(--muted-2);
        background: var(--surface);
        font-size: 10px;
        line-height: 1.35;
        text-align: center;
    }

    .file {
        display: grid;
        grid-template-columns: 31px minmax(0,1fr) 27px;
        gap: 7px;
        align-items: center;
        min-height: 40px;
        padding: 5px 6px;
        border: 1px solid var(--border);
        border-radius: 9px;
        background: var(--surface);
        transition: .14s ease;
    }

    .file {
        animation: hvuFileEnter .22s cubic-bezier(.2,.8,.2,1) both;
    }

    .file:nth-child(2) { animation-delay: 18ms; }
    .file:nth-child(3) { animation-delay: 36ms; }
    .file:nth-child(4) { animation-delay: 54ms; }
    .file:nth-child(5) { animation-delay: 72ms; }

    .file:hover {
        border-color: var(--border-strong);
        background: var(--surface-hover);
        transform: translateX(2px);
    }

    .file-badge {
        width: 31px;
        height: 29px;
        display: grid;
        place-items: center;
        border-radius: 7px;
        color: var(--accent-2);
        background: var(--accent-soft);
        font-size: 7.5px;
        font-weight: 900;
        letter-spacing: .3px;
    }

    .file-main { min-width: 0; }

    .file-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--text);
        font-size: 10.3px;
        line-height: 1.2;
        font-weight: 700;
    }

    .file-meta {
        margin-top: 2px;
        color: var(--muted);
        font-size: 8.8px;
    }

    .download {
        width: 27px;
        height: 27px;
        display: grid;
        place-items: center;
        border: 1px solid var(--border);
        border-radius: 7px;
        color: var(--text);
        background: transparent;
        cursor: pointer;
        font-size: 13px;
        transition: .14s ease;
    }

    .download:hover {
        color: #fff;
        border-color: transparent;
        background: var(--accent);
        transform: translateY(-1px) scale(1.03);
    }

    .download:active {
        transform: scale(.9);
    }

    .update {
        display: none;
        margin-bottom: 8px;
        padding: 7px 8px;
        border: 1px solid color-mix(in srgb, var(--warning) 24%, transparent);
        border-radius: 9px;
        color: var(--text);
        background: color-mix(in srgb, var(--warning) 9%, var(--surface));
        font-size: 10px;
        line-height: 1.35;
    }

    .update.show { display: block; }

    .update a {
        color: var(--accent-2);
        font-weight: 800;
        text-decoration: none;
        cursor: pointer;
    }

    .footer {
        display: grid;
        grid-template-columns: repeat(3,1fr);
        gap: 4px;
        margin-top: 8px;
        padding-top: 7px;
        border-top: 1px solid var(--border);
    }

    .footer a {
        padding: 5px 3px;
        border-radius: 7px;
        color: var(--muted);
        text-align: center;
        text-decoration: none;
        font-size: 9px;
        transition: .14s ease;
    }

    .footer a:hover {
        color: var(--text);
        background: var(--surface);
    }

    /* SETTINGS */
    .settings-toolbar {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 10px;
    }

    .settings-back {
        width: 28px;
        height: 28px;
        display: grid;
        place-items: center;
        border: 1px solid var(--border);
        border-radius: 8px;
        color: var(--text);
        background: var(--surface);
        cursor: pointer;
        font-size: 13px;
    }

    .settings-heading {
        min-width: 0;
        flex: 1;
    }

    .settings-title {
        color: var(--text);
        font-size: 12.4px;
        font-weight: 800;
    }

    .settings-subtitle {
        margin-top: 2px;
        color: var(--muted);
        font-size: 10px;
    }

    .settings-group {
        margin-bottom: 12px;
    }

    .settings-label-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 6px;
    }

    .settings-label {
        color: var(--text);
        font-size: 10.2px;
        font-weight: 750;
    }

    .settings-hint {
        color: var(--muted-2);
        font-size: 8.8px;
    }

    .theme-grid {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 5px;
    }

    .theme-option {
        min-width: 0;
        padding: 5px 4px;
        border: 1px solid var(--border);
        border-radius: 8px;
        color: var(--muted);
        background: var(--surface);
        cursor: pointer;
        text-align: center;
        transition: .14s ease;
    }

    .theme-option {
        transition:
            transform .15s cubic-bezier(.2,.8,.2,1),
            color .15s ease,
            border-color .15s ease,
            background .15s ease;
    }

    .theme-option:hover,
    .theme-option.active {
        color: var(--text);
        border-color: color-mix(in srgb, var(--accent) 44%, var(--border));
        background: var(--surface-hover);
    }

    .theme-option:hover {
        transform: translateY(-1px);
    }

    .theme-option:active {
        transform: scale(.96);
    }

    .theme-option.active {
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 20%, transparent);
    }

    .theme-swatch {
        height: 17px;
        margin-bottom: 4px;
        overflow: hidden;
        border-radius: 5px;
        background: linear-gradient(135deg, #ef3f70, #3b1926);
    }

    .theme-option[data-theme-option="midnight"] .theme-swatch {
        background: linear-gradient(135deg, #4f7cff, #111b2d);
    }

    .theme-option[data-theme-option="ocean"] .theme-swatch {
        background: linear-gradient(135deg, #22d3ee, #0b3042);
    }

    .theme-option[data-theme-option="emerald"] .theme-swatch {
        background: linear-gradient(135deg, #34d399, #0d3329);
    }

    .theme-option[data-theme-option="violet"] .theme-swatch {
        background: linear-gradient(135deg, #c084fc, #281b45);
    }

    .theme-option[data-theme-option="graphite"] .theme-swatch {
        background: linear-gradient(135deg, #fb923c, #212328);
    }

    .theme-option[data-theme-option="light"] .theme-swatch {
        border: 1px solid rgba(15,23,42,.10);
        background: linear-gradient(135deg, #ffffff, #e7ebf1);
    }

    .theme-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 8.6px;
        font-weight: 700;
    }

    .segmented {
        display: grid;
        grid-template-columns: repeat(2,1fr);
        padding: 3px;
        border: 1px solid var(--border);
        border-radius: 9px;
        background: var(--surface);
    }

    .segmented.position {
        grid-template-columns: repeat(3,1fr);
    }

    .segment {
        min-height: 27px;
        border: 0;
        border-radius: 6px;
        color: var(--muted);
        background: transparent;
        cursor: pointer;
        font-size: 10.2px;
        font-weight: 700;
    }

    .segment.active {
        color: #fff;
        background: var(--accent);
    }

    .panel[data-theme="light"] .segment.active {
        color: #fff;
    }

    .image-preview-wrap {
        position: relative;
    }

    .image-preview {
        position: relative;
        height: 72px;
        display: grid;
        place-items: center;
        overflow: hidden;
        border: 1px dashed var(--border-strong);
        border-radius: 9px;
        color: var(--muted-2);
        background-color: var(--surface);
        background-size: cover;
        background-repeat: no-repeat;
        cursor: default;
        touch-action: none;
        user-select: none;
        font-size: 9.4px;
    }

    .menu-preview {
        height: 96px;
    }

    .image-preview.has-image {
        border-style: solid;
        cursor: grab;
    }

    .image-preview.has-image {
        transition:
            border-color .16s ease,
            box-shadow .16s ease,
            transform .16s ease;
    }

    .image-preview.has-image:hover {
        border-color: color-mix(in srgb, var(--accent) 38%, var(--border-strong));
        box-shadow: 0 7px 18px rgba(0,0,0,.10);
    }

    .image-preview.has-image:active,
    .image-preview.dragging {
        cursor: grabbing;
        transform: scale(.992);
    }

    .preview-placeholder {
        pointer-events: none;
    }

    .image-preview.has-image .preview-placeholder {
        display: none;
    }

    .drag-tip {
        position: absolute;
        left: 50%;
        bottom: 6px;
        transform: translateX(-50%);
        display: none;
        padding: 3px 6px;
        border-radius: 999px;
        color: #fff;
        background: rgba(0,0,0,.46);
        font-size: 7.8px;
        font-weight: 700;
        white-space: nowrap;
        pointer-events: none;
        backdrop-filter: blur(4px);
    }

    .image-preview.has-image:hover .drag-tip,
    .image-preview.dragging .drag-tip {
        display: block;
    }

    .position-readout {
        margin: 5px 1px 6px;
        color: var(--muted-2);
        text-align: right;
        font-size: 8.4px;
        font-variant-numeric: tabular-nums;
    }

    .compact-label-row {
        margin-top: 8px;
    }

    .image-actions {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 5px;
        margin-bottom: 8px;
    }

    .settings-button {
        min-height: 29px;
        padding: 0 9px;
        border: 1px solid var(--border);
        border-radius: 8px;
        color: var(--text);
        background: var(--surface);
        cursor: pointer;
        font-size: 9.6px;
        font-weight: 750;
        transition: .14s ease;
    }

    .settings-button:hover {
        border-color: var(--border-strong);
        background: var(--surface-hover);
    }

    .settings-button.accent {
        border-color: transparent;
        color: #fff;
        background: var(--accent);
    }

    .settings-button.danger {
        color: #fb7185;
    }

    .settings-button:disabled {
        cursor: wait;
        opacity: .65;
    }

    .range-row {
        display: grid;
        grid-template-columns: auto 1fr 34px;
        gap: 7px;
        align-items: center;
    }

    .range-row span {
        color: var(--muted);
        font-size: 10.2px;
    }

    input[type="range"] {
        width: 100%;
        accent-color: var(--accent);
    }

    .overlay-value {
        color: var(--text) !important;
        text-align: right;
        font-weight: 750;
    }

    .reset-row {
        margin-top: 2px;
        padding-top: 9px;
        border-top: 1px solid var(--border);
    }

    @keyframes hvuPanelEnter {
        from {
            opacity: 0;
            transform: translateY(-8px) scale(.975);
            filter: blur(2px);
        }
        to {
            opacity: 1;
            transform: translateY(0) scale(1);
            filter: blur(0);
        }
    }

    @keyframes hvuContentEnter {
        from {
            opacity: 0;
            transform: translateY(5px);
        }
        to {
            opacity: 1;
            transform: translateY(0);
        }
    }

    @keyframes hvuSettingsEnter {
        from {
            opacity: 0;
            transform: translateX(8px);
        }
        to {
            opacity: 1;
            transform: translateX(0);
        }
    }

    @keyframes hvuFileEnter {
        from {
            opacity: 0;
            transform: translateY(4px);
        }
        to {
            opacity: 1;
            transform: translateY(0);
        }
    }

    @keyframes hvuStatusPulse {
        0% {
            opacity: .75;
            transform: scale(.65);
        }
        70%, 100% {
            opacity: 0;
            transform: scale(1.55);
        }
    }

    @media (prefers-reduced-motion: reduce) {
        .panel,
        .main-screen,
        .panel.settings-open .settings-screen,
        .file,
        .dot::after {
            animation: none !important;
        }

        .content-shell,
        .collapse-icon,
        .icon-btn,
        .action-btn,
        .download,
        .theme-option,
        .image-preview.has-image {
            transition-duration: .01ms !important;
        }
    }

</style>

<div class="panel" id="panel" data-theme="hvu">
    <div class="panel-media" id="panelMedia"></div>
    <div class="panel-shade" id="panelShade"></div>

    <div class="header" id="dragHandle">
        <div class="header-media" id="headerMedia"></div>
        <div class="header-shade" id="headerShade"></div>

        <div class="logo">HVU</div>

        <div class="title-wrap">
            <div class="title-row">
                <div class="title">HVU Exam Helper</div>
                <span class="version">v${escapeHtml(VERSION)}</span>
            </div>
            <div class="subtitle">Exam & attachment tools</div>
        </div>

        <div class="header-actions">
            <button class="icon-btn" id="settingsBtn" title="Cài đặt" aria-label="Cài đặt">
                <svg class="header-icon" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 15.25A3.25 3.25 0 1 0 12 8.75a3.25 3.25 0 0 0 0 6.5Z"></path>
                    <path d="M19.14 12.94c.04-.31.06-.62.06-.94s-.02-.63-.07-.94l2.03-1.58-1.92-3.32-2.39.96a7.4 7.4 0 0 0-1.62-.94L14.87 3h-3.84l-.36 3.18c-.57.24-1.11.55-1.61.94l-2.4-.96-1.92 3.32 2.03 1.58c-.05.31-.07.63-.07.94s.02.63.07.94l-2.03 1.58 1.92 3.32 2.4-.96c.5.39 1.04.7 1.61.94l.36 3.18h3.84l.36-3.18c.58-.24 1.12-.55 1.62-.94l2.39.96 1.92-3.32-2.02-1.58Z"></path>
                </svg>
            </button>

            <button class="icon-btn collapse-btn" id="minimizeBtn" title="Thu gọn" aria-label="Thu gọn menu">
                <svg class="header-icon collapse-icon" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="m6.5 14.5 5.5-5 5.5 5"></path>
                </svg>
            </button>
        </div>
    </div>

    <div class="content-shell" id="contentShell">
    <div class="body main-screen" id="mainScreen">
        <div class="update" id="updateBox"></div>

        <div class="status" id="status">
            <span class="dot"></span>
            <span id="statusText">Đang chờ dữ liệu đề thi...</span>
        </div>

        <div class="stats">
            <div class="stat">
                <div class="stat-label">Câu hỏi</div>
                <div class="stat-value" id="questionCount">0</div>
            </div>
            <div class="stat">
                <div class="stat-label">Điểm</div>
                <div class="stat-value" id="scoreValue">—</div>
            </div>
            <div class="stat">
                <div class="stat-label">Tệp</div>
                <div class="stat-value" id="fileCount">0</div>
            </div>
        </div>

        <div class="actions">
            <button class="action-btn primary" id="saveFull">Lưu đề thi</button>
            <button class="action-btn secondary" id="saveAnswers">Đề + đáp án</button>
        </div>

        <div class="section-head">
            <div class="section-title">Tệp đính kèm</div>
            <div class="section-count" id="fileCountBadge">0 tệp</div>
        </div>

        <div class="files" id="files"></div>

        <div class="footer">
            <a href="https://zalo.me/${escapeHtml(CONFIG.ZALO)}" target="_blank" rel="noopener">Zalo</a>
            <a href="${escapeHtml(CONFIG.FACEBOOK)}" target="_blank" rel="noopener">Facebook</a>
            <a href="${escapeHtml(CONFIG.SHOP)}" target="_blank" rel="noopener">Bảng giá</a>
        </div>
    </div>

    <div class="settings-screen" id="settingsScreen">
        <div class="settings-toolbar">
            <button class="settings-back" id="settingsBack" title="Quay lại">←</button>
            <div class="settings-heading">
                <div class="settings-title">Tùy chỉnh giao diện</div>
                <div class="settings-subtitle">Thiết lập được lưu trên trình duyệt này</div>
            </div>
        </div>

        <div class="settings-group">
            <div class="settings-label-row">
                <div class="settings-label">Chủ đề</div>
                <div class="settings-hint">7 lựa chọn</div>
            </div>

            <div class="theme-grid">
                <button class="theme-option" data-theme-option="hvu">
                    <div class="theme-swatch"></div>
                    <div class="theme-name">HVU</div>
                </button>
                <button class="theme-option" data-theme-option="midnight">
                    <div class="theme-swatch"></div>
                    <div class="theme-name">Midnight</div>
                </button>
                <button class="theme-option" data-theme-option="ocean">
                    <div class="theme-swatch"></div>
                    <div class="theme-name">Ocean</div>
                </button>
                <button class="theme-option" data-theme-option="emerald">
                    <div class="theme-swatch"></div>
                    <div class="theme-name">Emerald</div>
                </button>
                <button class="theme-option" data-theme-option="violet">
                    <div class="theme-swatch"></div>
                    <div class="theme-name">Violet</div>
                </button>
                <button class="theme-option" data-theme-option="graphite">
                    <div class="theme-swatch"></div>
                    <div class="theme-name">Graphite</div>
                </button>
                <button class="theme-option" data-theme-option="light">
                    <div class="theme-swatch"></div>
                    <div class="theme-name">Light</div>
                </button>
            </div>
        </div>

        <div class="settings-group">
            <div class="settings-label-row">
                <div class="settings-label">Kích thước menu</div>
            </div>

            <div class="segmented">
                <button class="segment" data-density-option="compact">Gọn</button>
                <button class="segment" data-density-option="comfortable">Thoáng</button>
            </div>
        </div>

        <div class="settings-group">
            <div class="settings-label-row">
                <div class="settings-label">Ảnh nền tiêu đề</div>
                <div class="settings-hint">Kéo ảnh để chỉnh vị trí</div>
            </div>

            <div class="image-preview-wrap">
                <div class="image-preview header-preview" id="headerPreview">
                    <span class="preview-placeholder">Chưa chọn ảnh</span>
                    <span class="drag-tip">Giữ chuột và kéo</span>
                </div>
            </div>

            <div class="position-readout" id="headerPositionValue">X 50% · Y 50%</div>

            <div class="image-actions">
                <button class="settings-button accent" id="chooseHeaderImage">Chọn ảnh</button>
                <button class="settings-button danger" id="removeHeaderImage">Xóa</button>
            </div>

            <input id="headerImageInput" type="file" accept="image/*" hidden>

            <div class="settings-label-row compact-label-row">
                <div class="settings-label">Độ tối trên ảnh</div>
            </div>

            <div class="range-row">
                <span>Sáng</span>
                <input id="headerOverlay" type="range" min="10" max="80" step="1" value="46">
                <span class="overlay-value" id="headerOverlayValue">46%</span>
            </div>
        </div>

        <div class="settings-group">
            <div class="settings-label-row">
                <div class="settings-label">Ảnh nền toàn menu</div>
                <div class="settings-hint">Kéo ảnh để chỉnh vị trí</div>
            </div>

            <div class="image-preview-wrap">
                <div class="image-preview menu-preview" id="menuPreview">
                    <span class="preview-placeholder">Chưa chọn ảnh</span>
                    <span class="drag-tip">Giữ chuột và kéo</span>
                </div>
            </div>

            <div class="position-readout" id="menuPositionValue">X 50% · Y 50%</div>

            <div class="image-actions">
                <button class="settings-button accent" id="chooseMenuImage">Chọn ảnh</button>
                <button class="settings-button danger" id="removeMenuImage">Xóa</button>
            </div>

            <input id="menuImageInput" type="file" accept="image/*" hidden>

            <div class="settings-label-row compact-label-row">
                <div class="settings-label">Độ tối nền menu</div>
            </div>

            <div class="range-row">
                <span>Sáng</span>
                <input id="menuOverlay" type="range" min="15" max="85" step="1" value="54">
                <span class="overlay-value" id="menuOverlayValue">54%</span>
            </div>
        </div>

        <div class="reset-row">
            <button class="settings-button" id="resetAppearance" style="width:100%">
                Khôi phục giao diện mặc định
            </button>
        </div>
    </div>
    </div>
</div>`;

        document.body.appendChild(host);

        UI.host = host;
        UI.shadow = shadow;

        shadow.getElementById('saveFull').addEventListener('click', () => saveTest(false));
        shadow.getElementById('saveAnswers').addEventListener('click', () => saveTest(true));

        const panel = shadow.getElementById('panel');
        const minimizeBtn = shadow.getElementById('minimizeBtn');
        const savedState = getMenuState();

        if (savedState.minimized) {
            panel.classList.add('minimized');
            minimizeBtn.setAttribute('title', 'Mở rộng');
            minimizeBtn.setAttribute('aria-label', 'Mở rộng menu');
        }

        if (Number.isFinite(savedState.left)) {
            host.style.left = `${savedState.left}px`;
            host.style.right = 'auto';
        }

        if (Number.isFinite(savedState.top)) {
            host.style.top = `${savedState.top}px`;
        }

        minimizeBtn.addEventListener('click', event => {
            event.stopPropagation();

            panel.classList.toggle('minimized');
            const minimized = panel.classList.contains('minimized');

            minimizeBtn.setAttribute('title', minimized ? 'Mở rộng' : 'Thu gọn');
            minimizeBtn.setAttribute(
                'aria-label',
                minimized ? 'Mở rộng menu' : 'Thu gọn menu'
            );

            const state = getMenuState();
            saveMenuState({
                ...state,
                minimized
            });
        });

        bindSettingsUi();
        applyUiSettings(getUiSettings());
        makeDraggable(host, shadow.getElementById('dragHandle'));
        renderMenu();
    }

    function isElementInCurrentView(element) {
        if (!isElementNode(element) || !element.isConnected) return false;
        if (element.closest?.('#hvu-helper-host')) return false;

        // Reject content kept in the DOM by tab/accordion components but hidden.
        for (let current = element, depth = 0;
            current && depth < 10;
            current = current.parentElement, depth += 1) {

            if (current.hidden || current.getAttribute?.('aria-hidden') === 'true') return false;

            try {
                const style = getComputedStyle(current);
                if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
                    return false;
                }
            } catch {
                // Cross-realm/style failures should not break attachment discovery.
            }
        }

        // getClientRects() remains non-empty for elements that are merely below
        // the viewport, but is normally empty for collapsed/inactive lesson panes.
        try {
            if (typeof element.getClientRects === 'function' && element.getClientRects().length === 0) {
                return false;
            }
        } catch {
            // Ignore and keep the element if the browser cannot calculate rects.
        }

        return true;
    }

    function getCurrentViewAttachments() {
        const visible = [];
        const staleKeys = [];

        for (const item of ATTACHMENTS.values()) {
            const trigger = item.triggerElement;

            // v3.0.6 deliberately requires a live DOM anchor for menu items.
            // Network/JSON records without a DOM anchor stay internal and can
            // still resolve the real URL when the user downloads a visible item.
            if (!trigger || !isElementInCurrentView(trigger)) {
                if (trigger && !trigger.isConnected) staleKeys.push(item.key);
                continue;
            }

            visible.push(item);
        }

        // Remove attachments from lesson panes that were physically replaced by
        // the SPA. Hidden panes are only filtered, not deleted, in case the user
        // switches back without the LMS rebuilding their DOM.
        staleKeys.forEach(key => ATTACHMENTS.delete(key));

        return visible.sort((a, b) => {
            // Keep the page's natural visual order where possible.
            const aEl = a.triggerElement;
            const bEl = b.triggerElement;
            if (aEl && bEl && aEl !== bEl && aEl.isConnected && bEl.isConnected) {
                try {
                    const position = aEl.compareDocumentPosition(bEl);
                    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
                    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
                } catch {
                    // Fall back to capture time.
                }
            }
            return a.capturedAt - b.capturedAt;
        });
    }

    function renderMenu() {
        if (!UI.shadow) return;

        const questionCount = Object.keys(DATA.questions).length;
        const attachments = getCurrentViewAttachments();

        const status = UI.shadow.getElementById('status');
        const statusText = UI.shadow.getElementById('statusText');
        const questionCountEl = UI.shadow.getElementById('questionCount');
        const scoreValue = UI.shadow.getElementById('scoreValue');
        const fileCount = UI.shadow.getElementById('fileCount');
        const fileCountBadge = UI.shadow.getElementById('fileCountBadge');
        const files = UI.shadow.getElementById('files');

        questionCountEl.textContent = String(questionCount);
        scoreValue.textContent = DATA.score ? String(DATA.score.value) : '—';
        fileCount.textContent = String(attachments.length);
        fileCountBadge.textContent = `${attachments.length} tệp`;

        if (questionCount > 0) {
            status.classList.add('ready');
            statusText.innerHTML =
                `Đã bắt <b>${questionCount}</b> câu` +
                (DATA.testId ? ` · Mã ${escapeHtml(DATA.testId)}` : '');
        } else {
            status.classList.remove('ready');
            statusText.textContent = 'Đang chờ dữ liệu đề thi...';
        }

        if (!attachments.length) {
            files.innerHTML =
                '<div class="empty">Chưa phát hiện PDF, video, Word hoặc tệp đính kèm.</div>';
            return;
        }

        files.innerHTML = attachments.map(item => {
            const spec = FILE_TYPES[item.kind] || FILE_TYPES.other;
            const hasUrl = Boolean(item.url);
            return `
                <div class="file" data-key="${escapeHtml(item.key)}">
                    <div class="file-badge">${escapeHtml(spec.icon)}</div>
                    <div class="file-main">
                        <div class="file-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
                        <div class="file-meta">${escapeHtml(spec.label)}${hasUrl ? '' : ' · cần mở 1 lần'}</div>
                    </div>
                    <button class="download" data-download-key="${escapeHtml(item.key)}" title="Tải xuống">↓</button>
                </div>`;
        }).join('');

        files.querySelectorAll('[data-download-key]').forEach(button => {
            button.addEventListener('click', async () => {
                const key = button.getAttribute('data-download-key');
                const attachment = ATTACHMENTS.get(key);
                if (attachment) await downloadAttachment(attachment);
            });
        });
    }

    function makeDraggable(host, handle) {
        let dragging = false;
        let pointerId = null;
        let offsetX = 0;
        let offsetY = 0;

        handle.addEventListener('pointerdown', event => {
            if (event.target.closest('button, a')) return;

            dragging = true;
            pointerId = event.pointerId;
            handle.setPointerCapture?.(pointerId);

            const rect = host.getBoundingClientRect();
            offsetX = event.clientX - rect.left;
            offsetY = event.clientY - rect.top;

            host.style.right = 'auto';
            event.preventDefault();
        });

        handle.addEventListener('pointermove', event => {
            if (!dragging || event.pointerId !== pointerId) return;

            const width = host.offsetWidth || 326;
            const height = Math.min(host.offsetHeight || 60, window.innerHeight);
            const maxLeft = Math.max(0, window.innerWidth - width);
            const maxTop = Math.max(0, window.innerHeight - Math.min(height, 60));

            const left = Math.min(maxLeft, Math.max(0, event.clientX - offsetX));
            const top = Math.min(maxTop, Math.max(0, event.clientY - offsetY));

            host.style.left = `${left}px`;
            host.style.top = `${top}px`;
        });

        const finish = event => {
            if (!dragging || (event && event.pointerId !== pointerId)) return;
            dragging = false;

            try {
                handle.releasePointerCapture?.(pointerId);
            } catch {
                // Pointer may already be released.
            }

            const rect = host.getBoundingClientRect();
            const state = getMenuState();

            saveMenuState({
                ...state,
                left: Math.round(rect.left),
                top: Math.round(rect.top)
            });

            pointerId = null;
        };

        handle.addEventListener('pointerup', finish);
        handle.addEventListener('pointercancel', finish);
    }

    // =====================================================================
    // UPDATE CHECKER
    // =====================================================================
    function parseVersion(version) {
        return String(version || '')
            .split('.')
            .map(part => Number.parseInt(part, 10) || 0);
    }

    function isNewerVersion(latest, current) {
        const a = parseVersion(latest);
        const b = parseVersion(current);
        const length = Math.max(a.length, b.length);

        for (let i = 0; i < length; i += 1) {
            const av = a[i] || 0;
            const bv = b[i] || 0;
            if (av > bv) return true;
            if (av < bv) return false;
        }
        return false;
    }

    function checkForUpdate() {
        GM_xmlhttpRequest({
            method: 'GET',
            url: `${CONFIG.UPDATE_URL}?t=${Date.now()}`,
            onload: response => {
                const match = response.responseText?.match(/@version\s+([0-9.]+)/);
                if (!match?.[1]) return;

                const latestVersion = match[1];
                if (isNewerVersion(latestVersion, VERSION)) {
                    showUpdateNotice(latestVersion);
                }
            },
            onerror: () => {
                // Update failure should remain silent.
            }
        });
    }

    function showUpdateNotice(latestVersion) {
        if (!UI.shadow) return;

        const box = UI.shadow.getElementById('updateBox');
        if (!box) return;

        box.classList.add('show');
        box.innerHTML =
            `Có bản mới <b>v${escapeHtml(latestVersion)}</b> ` +
            `(đang dùng v${escapeHtml(VERSION)}). ` +
            `<a id="updateLink">Cập nhật</a>`;

        box.querySelector('#updateLink')?.addEventListener('click', () => {
            window.open(CONFIG.UPDATE_URL, '_blank', 'noopener');
        });
    }

    // =====================================================================
    // INITIALIZE
    // =====================================================================
    function onDomReady(callback) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', callback, { once: true });
        } else {
            callback();
        }
    }

    installNetworkInterceptors();
    loadExamState();

    onDomReady(() => {
        createFloatingMenu();
        startDomObserver();
        renderMenu();
        setTimeout(checkForUpdate, 1800);
    });

})();
