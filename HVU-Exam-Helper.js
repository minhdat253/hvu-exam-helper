// ==UserScript==
// @name         HVU Exam Helper v2.2
// @namespace    http://sv.shop/
// @version      2.2
// @description  Lưu đề thi HVU ra file Word + Tải PDF - Bypass CSP
// @author       SV Shop - Zalo 0359677390
// @match        https://sinhvien.hvu.edu.vn/*
// @match        https://*.ictu.edu.vn/*
// @icon         https://sinhvien.hvu.edu.vn/favicon.ico
// @grant        unsafeWindow
// @grant        GM_download
// @grant        GM_notification
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-start
// @noframes

// @downloadURL https://raw.githubusercontent.com/minhdat253/hvu-exam-helper/main/HVU-Exam-Helper.js
// @updateURL https://raw.githubusercontent.com/minhdat253/hvu-exam-helper/main/HVU-Exam-Helper.js
// ==/UserScript==


(function () {
    'use strict';

    // ======================== CONFIGURATION ========================
    const CONFIG = {
        ZALO: '0359677390',
        FACEBOOK: 'https://www.facebook.com/Dangdat352',
        SHOP: 'https://docs.google.com/spreadsheets/d/1KoQbsf7xffIciikuasRItIdpMyX4NXaYBRTYX5p5tGU/edit?usp=sharing',
        VERSION: '2.2'
    };

    // ======================== DATA STORAGE ========================
    const DATA = {
        questions: {},
        testId: null,
        userAnswers: {},
        score: null,
        timestamp: null,
        captured: false
    };

    console.log('%c[HVU Helper] 📚 Userscript v2.2 - Starting...', 'color: white; background: #673ab7; font-size: 14px; padding: 5px;');

    // ======================== UTILITY FUNCTIONS ========================
    function cleanHtml(html) {
        if (!html || typeof html !== 'string') return String(html || '');
        const div = document.createElement('div');
        div.innerHTML = html;
        return div.innerText.trim();
    }

    function escapeHtml(text) {
        return String(text || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    // ======================== PROCESS QUESTIONS ========================
    function processQuestions(questions, testId) {
        console.log('%c[HVU Helper] 🎯 BẮT ĐƯỢC ĐỀ THI! ' + questions.length + ' câu', 'color: #00ff00; font-size: 16px; font-weight: bold; background: #000; padding: 5px;');

        // RESET old data - clear previous exam data
        DATA.questions = {};
        DATA.userAnswers = {};
        DATA.score = null;

        DATA.testId = testId;
        DATA.timestamp = new Date().toLocaleString('vi-VN');
        DATA.captured = true;

        questions.forEach((q, idx) => {
            const qId = String(q.id);
            DATA.questions[qId] = {
                index: idx + 1,
                question: cleanHtml(q.question_direction || q.question || q.content),
                options: (q.answer_option || []).map(opt => ({
                    id: String(opt.id),
                    value: cleanHtml(opt.value || opt.content || opt.text)
                }))
            };
        });

        // Save to GM storage
        GM_setValue('currentTest', JSON.stringify(DATA));

        // Update floating menu
        updateMenuStatus();

        // Show notification
        GM_notification({
            title: 'HVU Exam Helper',
            text: `Đã bắt được ${questions.length} câu hỏi!`,
            timeout: 3000
        });
    }

    // ======================== PROCESS SCORE ========================
    function processScore(scoreData, userAnswers) {
        console.log('%c[HVU Helper] 📊 ĐIỂM: ' + scoreData.score, 'color: #ff9800; font-size: 16px; font-weight: bold;');

        DATA.score = {
            value: scoreData.score,
            passed: scoreData.passed === 1,
            total: scoreData.total_question,
            correct: Math.round((scoreData.score / 100) * scoreData.total_question)
        };
        DATA.userAnswers = userAnswers || {};

        GM_setValue('currentTest', JSON.stringify(DATA));
        GM_setValue('lastScore', JSON.stringify(DATA.score));

        updateMenuStatus();
    }

    // ======================== CHECK API RESPONSE ========================
    function checkResponse(url, responseText, requestBody) {
        try {
            const data = JSON.parse(responseText);

            // Check for test questions
            if ((url.includes('student-tests') || url.includes('class-plan-activity')) &&
                data.data && Array.isArray(data.data) && data.data.length > 0) {
                const testData = data.data[0];
                if (testData && testData.test && Array.isArray(testData.test) && testData.test.length > 0) {
                    processQuestions(testData.test, testData.id);
                }
            }

            // Check for score
            if (url.includes('/score/') && data.code === 'success' && data.score !== undefined) {
                let userAnswers = {};
                try { if (requestBody) userAnswers = JSON.parse(requestBody); } catch (e) { }
                processScore(data, userAnswers);
            }
        } catch (e) {
            // Not JSON
        }
    }

    // ======================== CAPTURED FILE URLS ========================
    // Store signed URLs from AWS file API
    const capturedFileUrls = {};
    unsafeWindow.__HVU_CAPTURED_FILES__ = capturedFileUrls;

    // ======================== INTERCEPT XMLHttpRequest ========================
    const OrigXHR = unsafeWindow.XMLHttpRequest;

    unsafeWindow.XMLHttpRequest = function () {
        const xhr = new OrigXHR();
        let _url = '', _body = '';

        const origOpen = xhr.open;
        xhr.open = function (method, url) {
            _url = url;
            return origOpen.apply(xhr, arguments);
        };

        const origSend = xhr.send;
        xhr.send = function (body) {
            _body = body || '';
            return origSend.apply(xhr, arguments);
        };

        xhr.addEventListener('readystatechange', function () {
            if (xhr.readyState === 4 && xhr.status === 200) {
                checkResponse(_url, xhr.responseText, _body);

                // Capture AWS file signed URLs
                if (_url.includes('/api/aws/file/') || _url.includes('/aws/file/')) {
                    try {
                        const data = JSON.parse(xhr.responseText);
                        if (data.code === 'success' && data.data) {
                            // Extract file ID from URL
                            const fileId = _url.match(/\/file\/(\d+)/)?.[1];
                            if (fileId) {
                                capturedFileUrls[fileId] = data.data;
                                capturedFileUrls['_last'] = data.data;
                                capturedFileUrls['_lastId'] = fileId;
                                console.log('[HVU Helper] 📥 Captured file URL for ID ' + fileId);
                            }
                        }
                    } catch (e) { }
                }
            }
        });

        return xhr;
    };
    unsafeWindow.XMLHttpRequest.prototype = OrigXHR.prototype;

    // ======================== INTERCEPT FETCH ========================
    const origFetch = unsafeWindow.fetch;

    unsafeWindow.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input.url || '');
        const body = init && init.body ? init.body : '';

        return origFetch.apply(this, arguments).then(response => {
            const clone = response.clone();
            clone.text().then(text => {
                checkResponse(url, text, body);

                // Capture AWS file signed URLs
                if (url.includes('/api/aws/file/') || url.includes('/aws/file/')) {
                    try {
                        const data = JSON.parse(text);
                        if (data.code === 'success' && data.data) {
                            const fileId = url.match(/\/file\/(\d+)/)?.[1];
                            if (fileId) {
                                capturedFileUrls[fileId] = data.data;
                                capturedFileUrls['_last'] = data.data;
                                capturedFileUrls['_lastId'] = fileId;
                                console.log('[HVU Helper] 📥 Captured file URL for ID ' + fileId);
                            }
                        }
                    } catch (e) { }
                }
            }).catch(() => { });
            return response;
        });
    };

    console.log('%c[HVU Helper] ✅ API Interceptors ACTIVE!', 'color: #4caf50; font-weight: bold;');

    // ======================== SAVE FUNCTIONS ========================
    function generateDocContent(includeAnswers) {
        const data = DATA;
        if (Object.keys(data.questions).length === 0) {
            // Try loading from storage
            const saved = GM_getValue('currentTest', null);
            if (saved) {
                Object.assign(data, JSON.parse(saved));
            }
        }

        if (Object.keys(data.questions).length === 0) {
            alert('Không có dữ liệu đề thi! Hãy vào trang thi trước.');
            return null;
        }

        return `<!DOCTYPE html>
<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word'>
<head><meta charset="UTF-8">
<style>
  body { font-family: 'Times New Roman', serif; font-size: 12pt; line-height: 1.8; margin: 40px; }
  .header { text-align: center; font-weight: bold; font-size: 18pt; margin-bottom: 20px; color: #333; }
  .info { margin-bottom: 15px; padding: 10px; background: #f5f5f5; border-radius: 5px; }
  .question { font-weight: bold; margin-top: 25px; padding: 10px; background: #e3f2fd; border-left: 4px solid #2196f3; }
  .option { margin-left: 30px; margin-bottom: 8px; padding: 5px 0; }
  .selected { color: #1565c0; font-weight: bold; background: #e3f2fd; padding: 5px 10px; border-radius: 3px; }
  .footer { text-align: center; margin-top: 40px; padding-top: 20px; border-top: 2px solid #ccc; font-size: 11pt; color: #666; }
</style>
</head>
<body>
<div class="header">📚 ĐỀ THI HVU${includeAnswers ? ' + ĐÁP ÁN ĐÃ CHỌN' : ''}</div>
<div class="info">
  <div><strong>⏰ Thời gian:</strong> ${data.timestamp || new Date().toLocaleString('vi-VN')}</div>
  <div><strong>🔢 Mã đề:</strong> ${data.testId || 'N/A'}</div>
  <div><strong>📝 Số câu:</strong> ${Object.keys(data.questions).length}</div>
  ${data.score ? `<div><strong>📊 Điểm:</strong> ${data.score.value} (${data.score.passed ? '✅ ĐẠT' : '❌ CHƯA ĐẠT'})</div>` : ''}
</div>
<hr>
${Object.entries(data.questions)
                .sort((a, b) => a[1].index - b[1].index)
                .map(([qId, q]) => {
                    const userAns = data.userAnswers ? data.userAnswers[qId] : null;
                    const selectedId = userAns ? (typeof userAns === 'object' ? userAns.answer : userAns) : null;
                    return `
<div class="question">Câu ${q.index}: ${escapeHtml(q.question)}</div>
${q.options.map((opt, i) => {
                        const letter = String.fromCharCode(65 + i);
                        const isSelected = includeAnswers && opt.id === selectedId;
                        return `<div class="option${isSelected ? ' selected' : ''}">${letter}. ${escapeHtml(opt.value)}${isSelected ? ' ◄ [ĐÃ CHỌN]' : ''}</div>`;
                    }).join('')}`;
                }).join('')}
<div class="footer">
  <strong>📱 Zalo:</strong> ${CONFIG.ZALO} | <strong>📘 FB:</strong> <a href="${CONFIG.FACEBOOK}">MinhDat</a><br>
  Lưu bởi Minh Đạt v${CONFIG.VERSION}
</div>
</body>
</html>`;
    }

    function saveTest(includeAnswers) {
        const content = generateDocContent(includeAnswers);
        if (!content) return;

        const filename = (includeAnswers ? 'DeThi_DapAn_HVU_' : 'DeThi_HVU_') +
            new Date().toISOString().slice(0, 10) + '.doc';

        const blob = new Blob([content], { type: 'application/msword' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);


        GM_notification({
            title: 'HVU Exam Helper',
            text: `Đã lưu: ${filename}`,
            timeout: 3000
        });
    }

    // ======================== PDF DOWNLOAD FEATURE ========================
    function addPdfDownloadButtons() {
        // Wait for DOM to be ready
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', addPdfDownloadButtons);
            return;
        }

        console.log('[HVU Helper] 📄 Đang tìm file PDF...');

        // Store URLs we've captured from network
        const capturedPdfUrls = {};

        // Track processed elements by their unique position
        const processedElements = new WeakSet();

        // Function to find and add buttons
        const checkAndAddButtons = function () {
            // Find all elements that contain PDF filename text
            const allSpans = document.querySelectorAll('span, div, a, p');

            allSpans.forEach(function (el) {
                // Skip if already processed
                if (processedElements.has(el)) return;

                // Skip if already has our button
                if (el.querySelector('.hvu-pdf-download')) return;
                if (el.classList.contains('hvu-pdf-download')) return;

                // Check if this element directly contains a PDF filename (not in child elements)
                const directText = el.childNodes.length > 0
                    ? Array.from(el.childNodes)
                        .filter(n => n.nodeType === Node.TEXT_NODE)
                        .map(n => n.textContent.trim())
                        .join('')
                    : el.textContent.trim();

                // Match PDF filename
                const pdfMatch = directText.match(/[\w\-\s\.\u00C0-\u024F]+\.pdf/i);

                if (pdfMatch && directText.length < 100) {
                    const filename = pdfMatch[0].trim();

                    // Check if this element is the "correct" one (contains mainly the filename)
                    // Avoid selecting parent containers that contain multiple items
                    if (el.children.length > 3) return; // Too many children = container

                    // Check if there's already a button nearby (in parent or siblings)
                    const parentEl = el.parentElement;
                    if (parentEl) {
                        // Check if parent already has our button
                        if (parentEl.querySelector('.hvu-pdf-download')) return;

                        // Check if any sibling already has our button for same file
                        const siblings = parentEl.children;
                        let hasButton = false;
                        for (let i = 0; i < siblings.length; i++) {
                            if (siblings[i].classList && siblings[i].classList.contains('hvu-pdf-download')) {
                                hasButton = true;
                                break;
                            }
                        }
                        if (hasButton) return;
                    }

                    // Mark as processed
                    processedElements.add(el);

                    // Add button directly after the element (not inside a container)
                    addSmartDownloadButton(el, filename);
                    console.log('[HVU Helper] 📥 Added button for: ' + filename);
                }
            });
        };

        // Find PDF URL in element or its parents
        function findPdfUrl(element, filename) {
            // Check for direct links
            let url = null;

            // Search in current and parent elements
            let current = element;
            for (let i = 0; i < 5 && current; i++) {
                // Check links
                const links = current.querySelectorAll('a[href]');
                links.forEach(function (link) {
                    if (link.href && (link.href.includes('.pdf') || link.href.includes('/files/') || link.href.includes('blob:'))) {
                        url = link.href;
                    }
                });

                // Check data attributes
                if (!url) {
                    const dataUrl = current.getAttribute('data-url') ||
                        current.getAttribute('data-src') ||
                        current.getAttribute('data-file');
                    if (dataUrl && dataUrl.includes('.pdf')) url = dataUrl;
                }

                // Check onclick handlers
                if (!url && current.onclick) {
                    const onclickStr = current.onclick.toString();
                    const urlMatch = onclickStr.match(/https?:\/\/[^\s'"]+\.pdf/i);
                    if (urlMatch) url = urlMatch[0];
                }

                current = current.parentElement;
            }

            // Check captured URLs
            if (!url && filename && capturedPdfUrls[filename.toLowerCase()]) {
                url = capturedPdfUrls[filename.toLowerCase()];
            }

            return url;
        }

        // Add download button with known URL
        function addDownloadButton(container, url, filename) {
            if (container.querySelector('.hvu-pdf-download')) return;

            const btn = createButton(filename);
            btn.onclick = function (e) {
                e.preventDefault();
                e.stopPropagation();
                downloadPdf(url, filename);
            };

            container.appendChild(btn);
            console.log('[HVU Helper] 📥 Đã thêm nút tải: ' + filename);
        }

        // Add smart download button that finds URL when clicked
        function addSmartDownloadButton(container, filename) {
            if (container.querySelector('.hvu-pdf-download')) return;

            const btn = createButton(filename);
            btn.onclick = function (e) {
                e.preventDefault();
                e.stopPropagation();

                // Try to find the PDF URL by clicking nearby elements or using captured data
                let url = findPdfUrl(container, filename);

                // Check captured AWS file URLs (signed URLs from API)
                if (!url && capturedFileUrls['_last']) {
                    url = capturedFileUrls['_last'];
                    console.log('[HVU Helper] Using captured AWS signed URL');
                }

                // Check captured blob URLs
                if (!url && capturedPdfUrls['_lastBlob']) {
                    url = capturedPdfUrls['_lastBlob'];
                    console.log('[HVU Helper] Using captured blob URL');
                }

                // Check for iframe with blob URL or PDF source
                if (!url) {
                    const iframe = document.querySelector('iframe[src^="blob:"], iframe[src*="viettelcloud"], embed[src^="blob:"], object[data^="blob:"]');
                    if (iframe) {
                        url = iframe.src || iframe.getAttribute('data');
                        console.log('[HVU Helper] Found iframe URL');
                    }
                }

                // Check global captured files
                if (!url && unsafeWindow.__HVU_CAPTURED_FILES__ && unsafeWindow.__HVU_CAPTURED_FILES__['_last']) {
                    url = unsafeWindow.__HVU_CAPTURED_FILES__['_last'];
                    console.log('[HVU Helper] Using global captured URL');
                }

                if (url) {
                    downloadPdf(url, filename);
                    return;
                }

                // If still no URL, try clicking the PDF element to trigger API call
                const clickableParent = container.querySelector('a, [onclick], [role="button"], span, div[class*="file"]');
                if (clickableParent) {
                    // Show instruction and click to trigger API
                    console.log('[HVU Helper] Clicking to trigger PDF load...');
                    clickableParent.click();

                    // Wait for API response then try download again
                    setTimeout(function () {
                        let capturedUrl = capturedFileUrls['_last'] || unsafeWindow.__HVU_CAPTURED_FILES__?.['_last'];
                        if (capturedUrl) {
                            console.log('[HVU Helper] Found URL after click: ' + capturedUrl.substring(0, 50) + '...');
                            downloadPdf(capturedUrl, filename);
                        } else {
                            alert('PDF đã mở. Hãy nhấn nút "Tải xuống" lần nữa để tải file.');
                        }
                    }, 2000);
                    return;
                }

                alert('Không tìm được link PDF. Hãy click vào tên file PDF để mở trước, sau đó nhấn nút tải lần nữa.');
            };

            container.appendChild(btn);
            console.log('[HVU Helper] 📥 Đã thêm nút tải thông minh: ' + filename);
        }

        // Create button element
        function createButton(filename) {
            const btn = document.createElement('button');
            btn.className = 'hvu-pdf-download';
            btn.innerHTML = '📥 Tải xuống';
            btn.title = 'Tải ' + filename;
            btn.style.cssText = `
                display: inline-block;
                margin-left: 10px;
                padding: 6px 14px;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                border: none;
                border-radius: 5px;
                font-size: 12px;
                cursor: pointer;
                transition: all 0.2s;
                font-family: inherit;
            `;
            btn.onmouseover = function () {
                this.style.transform = 'scale(1.05)';
                this.style.boxShadow = '0 4px 15px rgba(102, 126, 234, 0.4)';
            };
            btn.onmouseout = function () {
                this.style.transform = 'scale(1)';
                this.style.boxShadow = 'none';
            };
            return btn;
        }

        // Download PDF
        function downloadPdf(url, filename) {
            console.log('[HVU Helper] Đang tải: ' + url);

            GM_notification({
                title: 'HVU Exam Helper',
                text: 'Đang tải: ' + filename,
                timeout: 2000
            });

            if (url.startsWith('blob:')) {
                // For blob URLs, open in new tab
                window.open(url, '_blank');
            } else {
                // Try direct download first
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                a.target = '_blank';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
            }
        }

        // Capture PDF URLs from network requests
        const origXhr = unsafeWindow.XMLHttpRequest;
        const xhrOpen = origXhr.prototype.open;
        origXhr.prototype.open = function (method, url) {
            if (url && typeof url === 'string' && url.toLowerCase().includes('.pdf')) {
                const filename = url.split('/').pop().split('?')[0];
                capturedPdfUrls[filename.toLowerCase()] = url;
                console.log('[HVU Helper] Captured PDF URL: ' + filename);
            }
            return xhrOpen.apply(this, arguments);
        };

        // Capture blob URLs when created
        const origCreateObjectURL = unsafeWindow.URL.createObjectURL;
        let lastBlobUrl = null;
        unsafeWindow.URL.createObjectURL = function (blob) {
            const url = origCreateObjectURL.apply(this, arguments);

            // Check if it's a PDF blob
            if (blob && (blob.type === 'application/pdf' || blob.type.includes('pdf'))) {
                lastBlobUrl = url;
                capturedPdfUrls['_lastBlob'] = url;
                console.log('[HVU Helper] 📄 Captured PDF Blob URL: ' + url);
            }

            return url;
        };

        // Also monitor for iframes with blob URLs
        setInterval(function () {
            const iframes = document.querySelectorAll('iframe[src^="blob:"], embed[src^="blob:"], object[data^="blob:"]');
            iframes.forEach(function (frame) {
                const src = frame.src || frame.getAttribute('data');
                if (src && src.startsWith('blob:')) {
                    capturedPdfUrls['_lastBlob'] = src;
                    lastBlobUrl = src;
                    console.log('[HVU Helper] Found PDF iframe: ' + src);
                }
            });
        }, 1000);

        // Run check periodically
        setTimeout(checkAndAddButtons, 1000);
        setTimeout(checkAndAddButtons, 3000);
        setInterval(checkAndAddButtons, 5000);

        // Run on mutations
        new MutationObserver(function () {
            setTimeout(checkAndAddButtons, 500);
        }).observe(document.body, { subtree: true, childList: true });
    }

    // Initialize PDF download feature
    addPdfDownloadButtons();

    // ======================== FLOATING MENU ========================
    function createFloatingMenu() {
        // Wait for DOM
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', createFloatingMenu);
            return;
        }

        const menu = document.createElement('div');
        menu.id = 'hvu-helper-menu';
        menu.innerHTML = `
            <style>
                #hvu-helper-menu {
                    position: fixed;
                    top: 80px;
                    right: 20px;
                    width: 280px;

                    user-select: none;
                    -webkit-user-select: none;
                    -moz-user-select: none;
                    -ms-user-select: none;
                    background: linear-gradient(135deg, #2d0b18 0%, #4a1022 50%, #651b2e 100%);
                    border: 1px solid rgba(255,255,255,0.08);
                    backdrop-filter: blur(8px);
                    border-radius: 12px;
                    box-shadow: 0 10px 40px rgba(0,0,0,0.4);
                    font-family: 'Segoe UI', sans-serif;
                    z-index: 999999;
                    color: #fff;
                    overflow: hidden;
                }

                #hvu-helper-menu .header {
                    position: relative;
                    overflow: hidden;
                    color: #000;
                    padding: 12px 15px;
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    cursor: move;
                }
                #hvu-helper-menu .header::before {
                    content: "";
                    position: absolute;
                    inset: 0;
                    background-image: url('https://t3.ftcdn.net/jpg/08/91/79/42/240_F_891794275_rSxllf7MZtgLXzgzVCxdbxR11PLpi7SY.jpg');
                    background-size: cover;
                    background-position: 0px -50px;
                    background-repeat: no-repeat;
                    z-index: 0;
                }
                #hvu-helper-menu .header > * {
                    position: relative;
                    z-index: 1;
                }

                #hvu-helper-menu .header h3 { margin: 0; font-size: 14px; flex: 1; color: #ffffff; text-shadow: 0 0 5px rgba(0,0,0,1), 0 0 10px rgba(0,0,0,1), 0 0 15px rgba(0,0,0,1), 2px 2px 4px rgba(0,0,0,1), 4px 4px 8px rgba(0,0,0,0.9);}
                #hvu-helper-menu .header .version { font-size: 10px; opacity: 0.8; color: #ffffff; text-shadow: 0 0 5px rgba(0,0,0,1), 0 0 10px rgba(0,0,0,1), 0 0 15px rgba(0,0,0,1), 2px 2px 4px rgba(0,0,0,1), 4px 4px 8px rgba(0,0,0,0.9);}
                #hvu-helper-menu .header .minimize { cursor: pointer; font-size: 18px; }
                #hvu-helper-menu .content {
                    padding: 12px;
                    max-height: 500px;
                    overflow: hidden;
                    opacity: 1;
                    transition:
                    max-height 0.35s ease,
                    opacity 0.25s ease,
                    padding 0.35s ease;
                }
                #hvu-helper-menu .content.hidden {
                    max-height: 0;
                    opacity: 0;
                    padding-top: 0;
                    padding-bottom: 0;
                }
                #hvu-helper-menu .status { background: rgba(255,255,255,0.08); padding: 8px 12px; border-radius: 8px; margin-bottom: 10px; font-size: 12px; }
                #hvu-helper-menu .status.success { border-left: 3px solid #4caf50; }
                #hvu-helper-menu .status.waiting { border-left: 3px solid #ff9800; }
                #hvu-helper-menu .btn {
                    width: 100%;
                    padding: 10px;
                    border: none;
                    border-radius: 8px;
                    font-size: 13px;
                    cursor: pointer;
                    margin-bottom: 8px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 8px;
                    transition: transform 0.2s;
                }
                #hvu-helper-menu .btn:hover { transform: translateY(-2px); }
                #hvu-helper-menu .btn-primary { background: linear-gradient(135deg, #ff4d6d 0%, #ff758f 100%); color: #fff; }
                #hvu-helper-menu .btn-success { background: linear-gradient(135deg, #7ed957 0%, #4caf50 100%); color: #fff; }
                #hvu-helper-menu .score-box { background: linear-gradient(135deg, #ff4d6d 0%, #ff758f 100%); padding: 15px; border-radius: 8px; text-align: center; margin-bottom: 10px; }
                #hvu-helper-menu .score-box.failed { background: linear-gradient(135deg, #c2185b 0%, #e91e63 100%); }
                #hvu-helper-menu .score-value { font-size: 32px; font-weight: bold; }
                #hvu-helper-menu .links { border-top: 1px solid #2a2a4a; padding-top: 10px; margin-top: 5px; }
                #hvu-helper-menu .link { display: block; padding: 8px 10px; color: #aaa; text-decoration: none; font-size: 12px; border-radius: 5px; }
                #hvu-helper-menu .link:hover {background: rgba(255,255,255,0.08); color: #ff8fab; }
            </style>
            <div class="header">
                <span>📚</span>
                <h3>HVU Exam Helper</h3>
                <span class="version">v${CONFIG.VERSION}</span>
                <span class="minimize" id="hvu-minimize">−</span>
            </div>
            <div class="content" id="hvu-content">
                <div class="status waiting" id="hvu-status">⏳ Đang chờ bắt đề thi...</div>
                <div id="hvu-score-container"></div>
                <button class="btn btn-primary" id="hvu-save-full">💾 Lưu đề thi đầy đủ</button>
                <button class="btn btn-success" id="hvu-save-answers">✅ Lưu đề + đáp án đã chọn</button>
                <div class="links">
                    <a class="link" href="https://zalo.me/${CONFIG.ZALO}" target="_blank">📱 Zalo: ${CONFIG.ZALO}</a>
                    <a class="link" href="${CONFIG.FACEBOOK}" target="_blank">📘 Truy cập trang Facebook</a>
                    <a class="link" href="${CONFIG.SHOP}" target="_blank">🛒 Bảng giá dịch vụ</a>
                </div>
            </div>
        `;

        document.body.appendChild(menu);

        // Event handlers
        document.getElementById('hvu-minimize').addEventListener('click', function () {
            const content = document.getElementById('hvu-content');
            content.classList.toggle('hidden');
            this.textContent = content.classList.contains('hidden') ? '+' : '−';
        });

        document.getElementById('hvu-save-full').addEventListener('click', () => saveTest(false));
        document.getElementById('hvu-save-answers').addEventListener('click', () => saveTest(true));

        // Make draggable
        makeDraggable(menu);
    }

    function updateMenuStatus() {
        const status = document.getElementById('hvu-status');
        const scoreContainer = document.getElementById('hvu-score-container');

        if (status) {
            const count = Object.keys(DATA.questions).length;
            if (count > 0) {
                status.className = 'status success';
                status.innerHTML = `✅ Đã bắt được <strong>${count}</strong> câu hỏi!`;
            }
        }

        if (scoreContainer && DATA.score) {
            scoreContainer.innerHTML = `
                <div class="score-box ${DATA.score.passed ? '' : 'failed'}">
                    <div class="score-value">${DATA.score.value}</div>
                    <div>${DATA.score.correct}/${DATA.score.total} câu đúng</div>
                </div>
            `;
        }
    }

    function makeDraggable(element) {
        const header = element.querySelector('.header');
        let isDragging = false, offsetX, offsetY;

        header.addEventListener('mousedown', (e) => {
            if (e.target.classList.contains('minimize')) return;
            isDragging = true;
            offsetX = e.clientX - element.offsetLeft;
            offsetY = e.clientY - element.offsetTop;
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            element.style.left = (e.clientX - offsetX) + 'px';
            element.style.top = (e.clientY - offsetY) + 'px';
            element.style.right = 'auto';
        });

        document.addEventListener('mouseup', function () { isDragging = false; });
    }

    // ======================== INITIALIZE ========================
    createFloatingMenu();

    // Load saved data
    const savedTest = GM_getValue('currentTest', null);
    if (savedTest) {
        try {
            Object.assign(DATA, JSON.parse(savedTest));
            if (DATA.captured) {
                updateMenuStatus();
            }
        } catch (e) { }
    }

})();
