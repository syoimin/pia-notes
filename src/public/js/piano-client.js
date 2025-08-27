/**
 * Piano Client - タブレット用クライアント (88鍵グランドピアノ対応)
 * ノーツ表示と演奏インターフェース
 */

class PianoClient {
    constructor(clientType, options = {}) {
        this.clientType = clientType; // 'melody' or 'accompaniment'
        this.options = {
            noteSpeed: options.noteSpeed || 120, // pixels per second
            lookAhead: options.lookAhead || 5, // seconds
            fallbackColor: clientType === 'melody' ? '#2196F3' : '#4CAF50',
            ...options
        };

        // DOM要素
        this.container = null;
        this.notesContainer = null;
        this.keyboardGuide = null;
        this.statusIndicator = null;
        this.bpmDisplay = null;
        this.timelineProgress = null;

        // 同期システム
        this.syncCore = null;
        
        // 演奏状態
        this.currentSong = null;
        this.activeNotes = new Map();
        this.animationId = null;
        this.autoStopTimer = null;
        this.endingSoon = false;
        
        // パフォーマンス最適化
        this.lastFrameTime = 0;
        this.frameRate = 60;
        this.frameInterval = 1000 / 60; // 60FPS固定

        this.initialize();
    }

    async initialize() {
        try {
            // DOM初期化
            this.setupDOM();
            
            // 同期システム初期化
            this.syncCore = new PianoSyncCore({
                clientType: this.clientType
            });

            // イベントハンドラー設定
            this.setupEventHandlers();
            
            // タッチ/クリック対応
            this.setupInteraction();

            // console.log(`🎹 Piano Client (${this.clientType}) initialized`);
        } catch (error) {
            console.error('Failed to initialize Piano Client:', error);
        }
    }

    setupDOM() {
        this.container = document.querySelector('.piano-display') || document.body;
        
        // 既存のDOM要素を使用するかチェック
        if (!this.options.useExistingDOM) {
            // ノーツコンテナ
            this.notesContainer = document.createElement('div');
            this.notesContainer.className = 'notes-container';
            this.notesContainer.style.cssText = `
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                overflow: hidden;
            `;
            this.container.appendChild(this.notesContainer);

            // 鍵盤ガイド
            this.create88KeyKeyboard();

            // ステータス表示
            this.createStatusIndicators();

            // タイムライン
            this.createTimeline();
        } else {
            // 既存のDOM要素を使用
            this.notesContainer = document.getElementById('notesContainer') || this.container.querySelector('.notes-container');
            this.keyboardGuide = document.getElementById('keyboardGuide') || this.container.querySelector('.keyboard-guide');
            this.statusIndicator = document.getElementById('connectionStatus') || this.container.querySelector('.connection-status');
            this.bpmDisplay = document.getElementById('bpmDisplay') || this.container.querySelector('.bpm-display');
            this.timelineProgress = document.getElementById('timelineProgress') || this.container.querySelector('.timeline-progress');

            // 鍵盤ガイドが空の場合は88鍵を作成
            if (this.keyboardGuide && this.keyboardGuide.children.length === 0) {
                this.create88KeyKeyboard();
            }
        }
    }

    create88KeyKeyboard() {
        if (!this.keyboardGuide) {
            this.keyboardGuide = document.createElement('div');
            this.keyboardGuide.className = 'keyboard-guide';
            this.keyboardGuide.id = 'keyboardGuide';
            this.container.appendChild(this.keyboardGuide);
        }

        // 88鍵のピアノ鍵盤を作成 (A0からC8まで)
        const keys = this.generate88Keys();
        
        keys.forEach((keyData, index) => {
            const keyElement = document.createElement('div');
            keyElement.className = `key ${keyData.type}`;
            keyElement.dataset.note = keyData.note;
            keyElement.dataset.keyIndex = index;
            keyElement.textContent = keyData.label || '';
            
            // 基本スタイルはCSSで設定済み、追加のデータ属性のみ設定
            if (keyData.octave !== undefined) {
                keyElement.dataset.octave = keyData.octave;
            }
            
            this.keyboardGuide.appendChild(keyElement);

            // オクターブラベルの追加（Cキーのみ）
            if (keyData.note.includes('C') && keyData.type === 'white') {
                const octaveLabel = document.createElement('div');
                octaveLabel.className = 'octave-label';
                octaveLabel.textContent = `C${keyData.octave}`;
                keyElement.appendChild(octaveLabel);
            }
        });

        // console.log(`🎹 Created 88-key keyboard with ${keys.length} keys`);
    }

    generate88Keys() {
        const keys = [];
        const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        const whiteKeys = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
        
        // A0から開始
        keys.push({ note: 'A0', type: 'white', octave: 0, label: 'A' });
        keys.push({ note: 'A#0', type: 'black', octave: 0 });
        keys.push({ note: 'B0', type: 'white', octave: 0, label: 'B' });

        // C1からC8まで
        for (let octave = 1; octave <= 8; octave++) {
            for (let i = 0; i < noteNames.length; i++) {
                const noteName = noteNames[i];
                const fullNote = `${noteName}${octave}`;
                const isWhite = whiteKeys.includes(noteName);
                
                keys.push({
                    note: fullNote,
                    type: isWhite ? 'white' : 'black',
                    octave: octave,
                    label: isWhite ? noteName : ''
                });

                // C8で終了
                if (octave === 8 && noteName === 'C') {
                    break;
                }
            }
        }

        return keys;
    }

    createStatusIndicators() {
        // 接続状態
        this.statusIndicator = document.createElement('div');
        this.statusIndicator.className = 'connection-status';
        this.statusIndicator.innerHTML = `
            <span class="status-indicator status-connecting"></span>
            <span>接続中...</span>
        `;
        this.container.appendChild(this.statusIndicator);

        // BPM表示
        this.bpmDisplay = document.createElement('div');
        this.bpmDisplay.className = 'bpm-display';
        this.bpmDisplay.textContent = 'BPM: --';
        this.container.appendChild(this.bpmDisplay);

        // 手の表示
        const handIndicator = document.createElement('div');
        handIndicator.className = 'hand-indicator';
        handIndicator.style.cssText = `
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            font-size: 48px;
            opacity: 0.3;
            pointer-events: none;
            z-index: 1;
        `;
        handIndicator.textContent = this.clientType === 'melody' ? '👉' : '🖐️';
        this.container.appendChild(handIndicator);
    }

    createTimeline() {
        this.timeline = document.createElement('div');
        this.timeline.className = 'timeline';
        
        this.timelineProgress = document.createElement('div');
        this.timelineProgress.className = 'timeline-progress';
        this.timeline.appendChild(this.timelineProgress);
        
        this.container.appendChild(this.timeline);
    }

    setupEventHandlers() {
        // 同期システムイベント
        this.syncCore.on('connected', () => {
            this.updateConnectionStatus('connected', '同期サーバーに接続');
            
            // ローディング画面を隠す（存在する場合）
            const loadingOverlay = document.getElementById('loadingOverlay');
            if (loadingOverlay) {
                loadingOverlay.style.opacity = '0';
                setTimeout(() => {
                    loadingOverlay.style.display = 'none';
                }, 300);
            }
        });

        this.syncCore.on('disconnected', () => {
            this.updateConnectionStatus('disconnected', '接続が切断されました');
        });

        this.syncCore.on('connectionFailed', () => {
            // エラーメッセージを表示（存在する場合）
            const errorElement = document.getElementById('errorMessage');
            const errorText = document.getElementById('errorText');
            const loadingOverlay = document.getElementById('loadingOverlay');
            
            if (errorText) errorText.textContent = 'サーバーに接続できませんでした';
            if (errorElement) errorElement.style.display = 'block';
            if (loadingOverlay) loadingOverlay.style.display = 'none';
        });

        this.syncCore.on('syncStart', (data) => {
            this.startPerformance(data);
        });

        this.syncCore.on('syncStop', () => {
            this.stopPerformance();
        });

        this.syncCore.on('tempoChange', (data) => {
            this.updateBPM(data.bpm);
        });

        this.syncCore.on('latencyUpdate', (data) => {
            this.updateLatencyDisplay(data.latency);
        });

        // ページの可視性変更
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                this.resumePerformance();
            } else {
                this.pausePerformance();
            }
        });

        // ウィンドウリサイズ
        window.addEventListener('resize', () => {
            this.handleResize();
        });
    }

    setupInteraction() {
        // タッチで音声コンテキストを再開
        const resumeAudio = async () => {
            await this.syncCore.resumeAudioContext();
            document.removeEventListener('touchstart', resumeAudio);
            document.removeEventListener('click', resumeAudio);
        };

        document.addEventListener('touchstart', resumeAudio, { once: true });
        document.addEventListener('click', resumeAudio, { once: true });

        // 鍵盤インタラクション
        if (this.keyboardGuide) {
            this.keyboardGuide.addEventListener('touchstart', (e) => {
                e.preventDefault();
                this.handleKeyPress(e.target);
            });

            this.keyboardGuide.addEventListener('click', (e) => {
                this.handleKeyPress(e.target);
            });
        }

        // スクリーンロック防止
        this.preventScreenLock();
    }

    preventScreenLock() {
        // Wake Lock API
        if ('wakeLock' in navigator) {
            navigator.wakeLock.request('screen').catch(err => {
                console.log('Wake lock failed:', err);
            });
        }

        // フェイクビデオを使用したフォールバック
        const video = document.createElement('video');
        video.src = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc284NWF2YzEAAAAIZnJlZQAACKBtZGF0AAAC';
        video.muted = true;
        video.loop = true;
        video.play().catch(() => {}); // エラーを無視
    }

    startPerformance(data) {
        // console.log(`🎵 Starting ${this.clientType} performance`);
        // console.log('Song data:', data.song);
        // console.log(`Notes for ${this.clientType}:`, data.song[this.clientType]);

        this.currentSong = data.song;
        this.updateBPM(data.bpm);
        this.clearNotes();
        this.endingSoon = false; // 終了フラグをリセット
        
        // アニメーション開始
        this.startAnimation();
        
        // 背景色を変更して演奏中を示す
        document.body.style.background = `linear-gradient(135deg, ${this.options.fallbackColor}22, #1a1a1a)`;
        
        // クライアント側での自動停止タイマー（サーバーのバックアップ）
        if (this.autoStopTimer) {
            clearTimeout(this.autoStopTimer);
        }
        
        const stopDelay = (data.song.duration * 1000) + 2000; // 楽曲時間 + 2秒のバッファ
        this.autoStopTimer = setTimeout(() => {
            console.log(`🕐 Client-side auto-stop after ${data.song.duration}s`);
            this.stopPerformance();
        }, stopDelay);
        
        console.log(`⏰ Auto-stop scheduled in ${stopDelay / 1000}s`);
    }

    stopPerformance() {
        console.log(`🛑 Stopping ${this.clientType} performance`);
        
        // 自動停止タイマーをクリア
        if (this.autoStopTimer) {
            clearTimeout(this.autoStopTimer);
            this.autoStopTimer = null;
        }
        
        this.currentSong = null;
        this.stopAnimation();
        this.clearNotes();
        
        // 背景色をリセット
        document.body.style.background = '#1a1a1a';
        
        // タイムラインリセット
        const timelineElement = document.getElementById('timelineProgress') || this.timelineProgress;
        if (timelineElement) {
            timelineElement.style.width = '0%';
        }
    }

    startAnimation() {
        if (this.animationId) {
            console.log('⚠️ Animation already running');
            return;
        }
        
        console.log('🎬 Starting animation loop');
        
        const animate = (timestamp) => {
            if (!this.currentSong) {
                console.log('❌ Animation stopped - no current song');
                return;
            }
            
            // 毎フレーム実行（60FPS）
            this.updateNotes();
            this.updateTimeline();
            
            this.animationId = requestAnimationFrame(animate);
        };
        
        this.animationId = requestAnimationFrame(animate);
        console.log('✅ Animation loop started with ID:', this.animationId);
    }

    stopAnimation() {
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
    }

    updateNotes() {
        if (!this.currentSong || !this.syncCore.isPlaying) {
            console.log(`❌ Cannot update notes - Song: ${!!this.currentSong}, Playing: ${this.syncCore?.isPlaying}`);
            return;
        }
        
        const currentTime = this.syncCore.getMusicTime();
        const notes = this.currentSong[this.clientType] || [];
        
        // フレームカウント（デバッグ用）
        if (!this.frameCount) this.frameCount = 0;
        this.frameCount++;
        
        // 10フレームごとにログ出力
        if (this.frameCount % 10 === 0) {
            // console.log(`🎬 Frame ${this.frameCount}: updateNotes called - Time: ${currentTime.toFixed(2)}s, Notes: ${notes.length}`);
        }
        
        // 既存ノーツの位置を更新
        this.updateExistingNotes(currentTime);
        
        // 新しいノーツを追加
        this.addNewNotes(notes, currentTime);
        
        // 画面外のノーツを削除
        this.removeOffscreenNotes();
        
        // ヒットタイミングのチェック
        this.checkHitTiming(notes, currentTime);
        
        // DOM内のノーツ要素数を確認
        const domNotes = this.notesContainer.querySelectorAll('.note');
        if (this.frameCount % 30 === 0) { // 30フレームごと
            // console.log(`📊 Stats: activeNotes=${this.activeNotes.size}, DOM notes=${domNotes.length}`);
        }
    }

    updateExistingNotes(currentTime) {
        const containerHeight = this.container.clientHeight;
        let updatedCount = 0;
        
        // console.log(`🔄 updateExistingNotes called - Active notes: ${this.activeNotes.size}`);
        
        this.activeNotes.forEach((noteElement, noteId) => {
            const parts = noteId.split('_');
            const noteTime = parseFloat(parts[1]);
            const timeUntilNote = noteTime - currentTime;
            
            if (timeUntilNote > -1 && timeUntilNote <= this.options.lookAhead) {
                // 新しい位置を計算
                const progress = (this.options.lookAhead - timeUntilNote) / this.options.lookAhead;
                const newTop = Math.max(0, progress * (containerHeight - 200));
                
                // 現在の位置を取得
                const oldTop = parseInt(noteElement.style.top) || 0;
                
                // 位置を更新（滑らかなアニメーション）
                noteElement.style.top = `${newTop}px`;
                updatedCount++;
                
                // 位置が大きく変化した場合のみログ出力
                if (Math.abs(newTop - oldTop) > 5) {
                    console.log(`📍 Moving note ${parts[0]}: ${oldTop}px -> ${newTop}px (progress: ${progress.toFixed(3)}, timeUntil: ${timeUntilNote.toFixed(2)}s)`);
                }
                
                // ヒット直前で色を変える
                if (timeUntilNote <= 0.5 && timeUntilNote > 0) {
                    noteElement.style.background = `linear-gradient(135deg, ${this.options.fallbackColor}, #FF9800)`;
                    noteElement.style.transform = `scale(${1 + (0.5 - timeUntilNote) * 0.4})`;
                }
            } else if (timeUntilNote < -1) {
                // 画面外に出たノーツを削除
                console.log(`🗑️ Removing expired note: ${noteId} (timeUntil: ${timeUntilNote.toFixed(2)}s)`);
                noteElement.remove();
                this.activeNotes.delete(noteId);
            }
        });
        
        if (updatedCount > 0) {
            // console.log(`✅ Updated ${updatedCount} existing notes`);
        }
    }

    addNewNotes(notes, currentTime) {
        let addedCount = 0;
        // console.log(`🆕 addNewNotes called - Total notes: ${notes.length}, Current time: ${currentTime.toFixed(2)}s`);
        
        notes.forEach((noteData, index) => {
            const timeUntilNote = noteData.time - currentTime;
            const noteId = `${noteData.note}_${noteData.time}_${index}`;
            
            // 新しいノーツで、表示範囲内の場合
            if (timeUntilNote > 0 && timeUntilNote <= this.options.lookAhead && !this.activeNotes.has(noteId)) {
                // console.log(`➕ Adding new note: ${noteData.note} at ${noteData.time}s (${timeUntilNote.toFixed(2)}s until)`);
                this.createNoteElement(noteData, timeUntilNote, index);
                addedCount++;
            }
        });
        
        // console.log(`✅ Added ${addedCount} new notes`);
    }

    removeOffscreenNotes() {
        const containerHeight = this.container.clientHeight;
        
        this.activeNotes.forEach((noteElement, noteId) => {
            const rect = noteElement.getBoundingClientRect();
            
            // 画面下端より下に出たノーツを削除
            if (rect.top > containerHeight + 50) {
                noteElement.remove();
                this.activeNotes.delete(noteId);
                // console.log(`🗑️ Removed offscreen note: ${noteId}`);
            }
        });
    }

    checkHitTiming(notes, currentTime) {
        notes.forEach(noteData => {
            const timeUntilNote = noteData.time - currentTime;
            
            // ヒットタイミングのチェック
            if (Math.abs(timeUntilNote) < 0.1) {
                // console.log(`🎯 Hit timing for note: ${noteData.note}`);
                this.highlightKey(noteData.note);
                
                // 自動演奏音を出す
                if (Math.abs(timeUntilNote) < 0.05) {
                    this.playKeySound(noteData.note);
                }
            }
        });
    }

    createNoteElement(noteData, timeUntilNote, index) {
        const note = document.createElement('div');
        note.className = `note ${this.clientType}`;
        note.textContent = noteData.note.replace(/[0-9]/g, ''); // オクターブ番号を削除
        note.dataset.noteId = `${noteData.note}_${noteData.time}_${index}`;
        
        // 位置計算の詳細ログ
        const containerHeight = this.container.clientHeight;
        const progress = (this.options.lookAhead - timeUntilNote) / this.options.lookAhead;
        const topPosition = Math.max(0, progress * (containerHeight - 200));
        const leftPosition = this.calculateNotePosition(noteData);
        
        // console.log(`📍 Creating note ${noteData.note}: progress=${progress.toFixed(2)}, top=${topPosition}px, left=${leftPosition}px`);
        
        // スタイル設定
        note.style.cssText = `
            position: absolute;
            top: ${topPosition}px;
            left: ${leftPosition}px;
            width: ${this.clientType === 'melody' ? '50px' : '45px'};
            height: ${this.clientType === 'melody' ? '50px' : '45px'};
            border-radius: 50%;
            background: ${this.options.fallbackColor};
            color: white;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: bold;
            font-size: 14px;
            box-shadow: 0 4px 8px rgba(0,0,0,0.3);
            z-index: 10;
            transition: transform 0.1s ease;
            border: 2px solid rgba(255,255,255,0.3);
        `;
        
        // 指番号表示
        if (noteData.finger) {
            const fingerIndicator = document.createElement('span');
            fingerIndicator.textContent = noteData.finger;
            fingerIndicator.style.cssText = `
                position: absolute;
                top: -10px;
                right: -10px;
                width: 18px;
                height: 18px;
                background: rgba(255,255,255,0.9);
                color: #333;
                border-radius: 50%;
                font-size: 11px;
                font-weight: bold;
                display: flex;
                align-items: center;
                justify-content: center;
            `;
            note.appendChild(fingerIndicator);
        }
        
        this.notesContainer.appendChild(note);
        this.activeNotes.set(note.dataset.noteId, note);
        
        // console.log(`✅ Note element created and added to DOM: ${noteData.note}`);
    }

    calculateNotePosition(noteData) {
        // positionプロパティがある場合はそれを使用
        if (noteData.position !== undefined) {
            // console.log(`Using provided position: ${noteData.position}px for note ${noteData.note}`);
            return noteData.position;
        }

        // 88鍵対応のノートマッピング（A0からC8まで）
        const keyPositions = this.generate88KeyPositions();
        const position = keyPositions[noteData.note];
        
        if (position !== undefined) {
            // console.log(`Note ${noteData.note} mapped to position: ${position}px`);
            return position;
        }
        
        // フォールバック: 既存の計算方法
        const noteMap = {
            'C': 100, 'C#': 115, 'Db': 115,
            'D': 140, 'D#': 155, 'Eb': 155,
            'E': 180,
            'F': 220, 'F#': 235, 'Gb': 235,
            'G': 260, 'G#': 275, 'Ab': 275,
            'A': 300, 'A#': 315, 'Bb': 315,
            'B': 340
        };
        
        const noteWithoutOctave = noteData.note.replace(/[0-9]/g, '');
        const basePosition = noteMap[noteWithoutOctave] || 200;
        
        // オクターブによる調整
        const octave = parseInt(noteData.note.match(/\d/)?.[0] || '4');
        const octaveOffset = (octave - 4) * 280; // オクターブごとに280px移動
        
        const calculatedPosition = Math.max(50, Math.min(window.innerWidth - 100, basePosition + octaveOffset));
        console.log(`Calculated position: ${calculatedPosition}px for note ${noteData.note} (base: ${basePosition}, octave: ${octave})`);
        
        return calculatedPosition;
    }

    generate88KeyPositions() {
        const positions = {};
        const keyWidth = 28; // 白鍵の幅
        const blackKeyWidth = 18; // 黒鍵の幅
        const startX = 50; // 開始位置
        let currentX = startX;

        // A0, A#0, B0
        positions['A0'] = currentX;
        currentX += keyWidth;
        positions['A#0'] = currentX - blackKeyWidth / 2;
        positions['B0'] = currentX;
        currentX += keyWidth;

        // C1からC8まで
        const notePattern = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        const whiteKeys = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

        for (let octave = 1; octave <= 8; octave++) {
            for (let i = 0; i < notePattern.length; i++) {
                const noteName = notePattern[i];
                const fullNote = `${noteName}${octave}`;
                
                if (whiteKeys.includes(noteName)) {
                    positions[fullNote] = currentX;
                    currentX += keyWidth;
                } else {
                    // 黒鍵は前の白鍵の位置から少し右にオフセット
                    positions[fullNote] = currentX - keyWidth + (keyWidth - blackKeyWidth) / 2;
                }

                // C8で終了
                if (octave === 8 && noteName === 'C') {
                    break;
                }
            }
        }

        return positions;
    }

    highlightKey(noteName) {
        // 対応する鍵盤をハイライト
        const key = this.keyboardGuide?.querySelector(`[data-note="${noteName}"]`);
        if (key) {
            key.classList.add('active');
            key.style.background = this.options.fallbackColor;
            
            // 短時間後にハイライトを解除
            setTimeout(() => {
                key.classList.remove('active');
                key.style.background = key.classList.contains('black') ? 'linear-gradient(to bottom, #333, #111)' : 'linear-gradient(to bottom, #ffffff, #f5f5f5)';
            }, 200);
        }
    }

    updateTimeline() {
        if (!this.currentSong || !this.timelineProgress) return;
        
        const currentTime = this.syncCore.getMusicTime();
        const progress = Math.min((currentTime / this.currentSong.duration) * 100, 100);
        this.timelineProgress.style.width = `${progress}%`;
    }

    clearNotes() {
        if (this.notesContainer) {
            this.notesContainer.innerHTML = '';
        }
        this.activeNotes.clear();
    }

    updateConnectionStatus(status, message) {
        if (!this.statusIndicator) return;
        
        const indicator = this.statusIndicator.querySelector('.status-indicator');
        const text = this.statusIndicator.querySelector('span:last-child');
        
        if (indicator) indicator.className = `status-indicator status-${status}`;
        if (text) text.textContent = message;
    }

    updateBPM(bpm) {
        if (this.bpmDisplay) {
            this.bpmDisplay.textContent = `BPM: ${bpm}`;
        }
    }

    updateLatencyDisplay(latency) {
        if (this.statusIndicator && latency > 0) {
            const latencyText = this.statusIndicator.querySelector('.latency-text') || 
                               (() => {
                                   const span = document.createElement('span');
                                   span.className = 'latency-text';
                                   span.style.marginLeft = '10px';
                                   span.style.fontSize = '12px';
                                   span.style.opacity = '0.7';
                                   this.statusIndicator.appendChild(span);
                                   return span;
                               })();
            
            latencyText.textContent = `${latency.toFixed(0)}ms`;
            
            // 高レイテンシーの警告
            if (latency > 50) {
                latencyText.style.color = '#ff9800';
            } else {
                latencyText.style.color = '';
            }
        }
    }

    handleKeyPress(key) {
        if (!key.dataset.note) return;
        
        // 視覚的フィードバック
        key.style.transform = 'translateY(2px)';
        key.style.background = this.options.fallbackColor;
        
        setTimeout(() => {
            key.style.transform = '';
            key.style.background = key.classList.contains('black') ? 
                'linear-gradient(to bottom, #333, #111)' : 
                'linear-gradient(to bottom, #ffffff, #f5f5f5)';
        }, 150);
        
        // 音声フィードバック（オプション）
        this.playNoteSound(key.dataset.note);
    }

    playKeySound(noteName) {
        if (!this.syncCore.audioContext || this.syncCore.audioContext.state !== 'running') return;
        
        try {
            const midiNote = PianoSyncUtils.noteToMidi(noteName);
            if (!midiNote) return;
            
            // 簡単なサイン波での音生成
            const oscillator = this.syncCore.audioContext.createOscillator();
            const gainNode = this.syncCore.audioContext.createGainNode ? 
                              this.syncCore.audioContext.createGainNode() : 
                              this.syncCore.audioContext.createGain();
            
            oscillator.connect(gainNode);
            gainNode.connect(this.syncCore.audioContext.destination);
            
            // 周波数計算 (A4 = 440Hz)
            const frequency = 440 * Math.pow(2, (midiNote - 69) / 12);
            oscillator.frequency.value = frequency;
            oscillator.type = 'triangle'; // より柔らかい音
            
            // エンベロープ
            const now = this.syncCore.audioContext.currentTime;
            const gainValue = this.clientType === 'melody' ? 0.15 : 0.12; // 伴奏は少し小さく
            
            gainNode.gain.setValueAtTime(0, now);
            gainNode.gain.linearRampToValueAtTime(gainValue, now + 0.01);
            gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.8);
            
            oscillator.start(now);
            oscillator.stop(now + 0.8);
            
            // console.log(`🎵 Played note: ${noteName} (${frequency.toFixed(2)}Hz)`);
        } catch (error) {
            console.log('Sound play failed:', error);
        }
    }

    playNoteSound(noteName) {
        // playKeySoundと同じ実装
        this.playKeySound(noteName);
    }

    handleResize() {
        // リサイズ時の処理
        this.clearNotes();
    }

    resumePerformance() {
        if (this.currentSong && !this.animationId) {
            this.startAnimation();
        }
    }

    pausePerformance() {
        this.stopAnimation();
    }

    // デバッグ用: 強制的にテストノーツを作成
    createTestNote() {
        // console.log('🧪 Creating test note for debugging');

        const testNote = document.createElement('div');
        testNote.className = 'note test';
        testNote.textContent = 'TEST';
        testNote.style.cssText = `
            position: absolute;
            top: 50px;
            left: 200px;
            width: 60px;
            height: 60px;
            border-radius: 50%;
            background: red;
            color: white;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: bold;
            z-index: 999;
            animation: testDrop 3s linear;
        `;
        
        // CSS アニメーションを追加
        const style = document.createElement('style');
        style.textContent = `
            @keyframes testDrop {
                0% { top: 50px; }
                100% { top: 500px; }
            }
        `;
        document.head.appendChild(style);
        
        if (this.notesContainer) {
            this.notesContainer.appendChild(testNote);
        }
        
        // 3秒後に削除
        setTimeout(() => {
            testNote.remove();
            style.remove();
        }, 3000);
    }

    destroy() {
        this.stopAnimation();
        this.clearNotes();
        
        if (this.syncCore) {
            this.syncCore.disconnect();
        }

        // console.log(`🔌 Piano Client (${this.clientType}) destroyed`);
    }
}

// PianoSyncUtils（必要な場合）
class PianoSyncUtils {
    static noteToMidi(noteName) {
        const noteMap = {
            'C': 0, 'C#': 1, 'Db': 1,
            'D': 2, 'D#': 3, 'Eb': 3,
            'E': 4,
            'F': 5, 'F#': 6, 'Gb': 6,
            'G': 7, 'G#': 8, 'Ab': 8,
            'A': 9, 'A#': 10, 'Bb': 10,
            'B': 11
        };

        const match = noteName.match(/([A-G][#b]?)(\d+)/);
        if (!match) return null;

        const [, note, octave] = match;
        const noteValue = noteMap[note];
        if (noteValue === undefined) return null;

        return (parseInt(octave) + 1) * 12 + noteValue;
    }
}

// エクスポート
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PianoClient;
} else {
    window.PianoClient = PianoClient;
    window.PianoSyncUtils = PianoSyncUtils;
}