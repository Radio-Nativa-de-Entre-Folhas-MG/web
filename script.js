// script.js - Nativa FM 98.7 - Engine Professional Ultimate

(function() {
    'use strict';

    // ==================== CONFIGURAÇÕES ====================
    const STREAM_URL = 'https://stream.zeno.fm/emcg0pkcf4hvv';
    const METADATA_SSE = 'https://api.zeno.fm/mounts/metadata/subscribe/emcg0pkcf4hvv';
    const SILENCE_THRESHOLD = 0.008; // RMS abaixo disso por 10s -> reconexão
    const SILENCE_DURATION = 10000; // 10 segundos
    const RECONNECT_BACKOFF = [3000, 5000, 10000, 15000];

    // ==================== ESTADOS DO PLAYER ====================
    const PlayerState = {
        IDLE: 'idle',
        LOADING: 'loading',
        PLAYING: 'playing',
        BUFFERING: 'buffering',
        RECONNECTING: 'reconnecting',
        ERROR: 'error'
    };

    // ==================== ELEMENTOS DOM ====================
    const audioEl = document.getElementById('radioStream');
    const playPauseBtn = document.getElementById('playPauseBtn');
    const mainPlayBtn = document.getElementById('mainPlayBtn');
    const interactionOverlay = document.getElementById('interactionOverlay');
    const interactionBtn = document.getElementById('interactionBtn');
    const heroStatus = document.getElementById('heroStatus');
    const playerStatusLabel = document.getElementById('playerStatusLabel');
    const currentSong = document.getElementById('currentSong');
    const currentArtist = document.getElementById('currentArtist');
    const vuBarL = document.getElementById('vuBarL');
    const vuBarR = document.getElementById('vuBarR');
    const vuPeakL = document.getElementById('vuPeakL');
    const vuPeakR = document.getElementById('vuPeakR');
    const metaTitle = document.querySelector('.meta-title');
    const metaArtist = document.querySelector('.meta-artist');
    const equalizerCanvas = document.getElementById('equalizerCanvas');
    const ctxEqualizer = equalizerCanvas.getContext('2d');
    const playerCard = document.querySelector('.player-card');

    // ==================== VARIÁVEIS DE ÁUDIO ====================
    let audioContext = null;
    let mediaSource = null;
    let analyserLeft = null;
    let analyserRight = null;
    let analyserEQ = null;
    let splitterNode = null;
    let animationFrameId = null;
    let playerState = PlayerState.IDLE;
    let silenceTimer = null;
    let silenceStart = null;
    let reconnectAttempt = 0;
    let eventSource = null;
    let metadataTimeout = null;

    // ==================== INICIALIZAÇÃO DO PLAYER ====================
    function initAudioContext() {
        try {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            mediaSource = audioContext.createMediaElementSource(audioEl);
            
            // Analyser para equalizador (FFT)
            analyserEQ = audioContext.createAnalyser();
            analyserEQ.fftSize = 128; // 64 bins
            analyserEQ.smoothingTimeConstant = 0.75;
            
            // Splitter para canais estéreo
            splitterNode = audioContext.createChannelSplitter(2);
            
            // Analyser para canal esquerdo
            analyserLeft = audioContext.createAnalyser();
            analyserLeft.fftSize = 256;
            analyserLeft.smoothingTimeConstant = 0.85;
            
            // Analyser para canal direito
            analyserRight = audioContext.createAnalyser();
            analyserRight.fftSize = 256;
            analyserRight.smoothingTimeConstant = 0.85;
            
            // Conexões: mediaSource -> splitter -> (L -> analyserLeft, R -> analyserRight)
            // mediaSource -> analyserEQ -> destination
            mediaSource.connect(splitterNode);
            splitterNode.connect(analyserLeft, 0);
            splitterNode.connect(analyserRight, 1);
            
            // Conectar o EQ (mono mix para visual)
            mediaSource.connect(analyserEQ);
            analyserEQ.connect(audioContext.destination);
            
            // Conectar ao destino para áudio
            // (splitter não pode ir ao destino automaticamente, mas precisamos de áudio)
            // Vamos conectar ambos os canais ao destino via merge ou diretamente.
            // Solução: criar um gain node mixado ou conectar analyserLeft/Right ao destino?
            // Para áudio de fato, conectamos mediaSource também ao destination.
            const gainNode = audioContext.createGain();
            gainNode.gain.value = 1.0;
            mediaSource.connect(gainNode);
            gainNode.connect(audioContext.destination);
            
            console.log('[Nativa FM] AudioContext inicializado com sucesso.');
            return true;
        } catch (e) {
            console.error('[Nativa FM] Erro ao inicializar AudioContext:', e);
            return false;
        }
    }

    function startPlayback() {
        if (playerState === PlayerState.PLAYING || playerState === PlayerState.LOADING) return;
        setPlayerState(PlayerState.LOADING);
        
        if (!audioContext || audioContext.state === 'closed') {
            if (!initAudioContext()) {
                setPlayerState(PlayerState.ERROR);
                return;
            }
        }
        
        if (audioContext.state === 'suspended') {
            audioContext.resume().then(() => {
                console.log('[Nativa FM] AudioContext resumido.');
                playStream();
            }).catch(e => {
                console.error('[Nativa FM] Falha ao resumir AudioContext:', e);
                setPlayerState(PlayerState.ERROR);
            });
        } else {
            playStream();
        }
    }

    function playStream() {
        audioEl.src = STREAM_URL;
        audioEl.load();
        audioEl.play().then(() => {
            console.log('[Nativa FM] Streaming iniciado.');
            setPlayerState(PlayerState.PLAYING);
            startVisualization();
            startSilenceDetection();
            connectMetadataSSE();
        }).catch(err => {
            console.warn('[Nativa FM] Autoplay bloqueado:', err.message);
            setPlayerState(PlayerState.IDLE);
            showInteractionOverlay();
        });
    }

    function stopPlayback() {
        audioEl.pause();
        audioEl.src = '';
        setPlayerState(PlayerState.IDLE);
        stopVisualization();
        clearSilenceDetection();
        disconnectMetadataSSE();
        updatePlayButtons(false);
        heroStatus.textContent = '⏸️ PARADO';
        playerStatusLabel.textContent = '⏸️ PARADO — Nativa FM 98.7';
        currentSong.textContent = 'Streaming pausado';
        currentArtist.textContent = '';
        metaTitle.textContent = 'Aguardando informações da música...';
        metaArtist.textContent = '';
    }

    function setPlayerState(state) {
        playerState = state;
        updatePlayButtons(state === PlayerState.PLAYING);
        switch (state) {
            case PlayerState.IDLE:
                heroStatus.textContent = '⏸️ PARADO';
                playerStatusLabel.textContent = '⏸️ PARADO — Nativa FM 98.7';
                break;
            case PlayerState.LOADING:
                heroStatus.textContent = '🔄 CARREGANDO...';
                playerStatusLabel.textContent = '🔄 CARREGANDO — Nativa FM 98.7';
                break;
            case PlayerState.PLAYING:
                heroStatus.textContent = '🔴 AO VIVO';
                playerStatusLabel.textContent = '🔴 AO VIVO — Nativa FM 98.7';
                break;
            case PlayerState.BUFFERING:
                heroStatus.textContent = '⏳ BUFFERING';
                playerStatusLabel.textContent = '⏳ BUFFERING — Nativa FM 98.7';
                break;
            case PlayerState.RECONNECTING:
                heroStatus.textContent = '🔄 RECONECTANDO...';
                playerStatusLabel.textContent = '🔄 RECONECTANDO — Nativa FM 98.7';
                break;
            case PlayerState.ERROR:
                heroStatus.textContent = '⚠️ ERRO';
                playerStatusLabel.textContent = '⚠️ ERRO — Nativa FM 98.7';
                break;
        }
        console.log(`[Nativa FM] Estado do player: ${state}`);
    }

    function updatePlayButtons(isPlaying) {
        const playHeader = playPauseBtn.querySelector('.play-icon');
        const pauseHeader = playPauseBtn.querySelector('.pause-icon');
        const playMain = mainPlayBtn.querySelector('.play-icon-large');
        const pauseMain = mainPlayBtn.querySelector('.pause-icon-large');
        const btnText = playPauseBtn.querySelector('.btn-text');
        
        if (isPlaying) {
            if (playHeader) playHeader.style.display = 'none';
            if (pauseHeader) pauseHeader.style.display = 'inline';
            if (playMain) playMain.style.display = 'none';
            if (pauseMain) pauseMain.style.display = 'inline';
            if (btnText) btnText.textContent = 'Parar';
        } else {
            if (playHeader) playHeader.style.display = 'inline';
            if (pauseHeader) pauseHeader.style.display = 'none';
            if (playMain) playMain.style.display = 'inline';
            if (pauseMain) pauseMain.style.display = 'none';
            if (btnText) btnText.textContent = 'Ouvir';
        }
    }

    function showInteractionOverlay() {
        interactionOverlay.classList.remove('hidden');
    }

    function hideInteractionOverlay() {
        interactionOverlay.classList.add('hidden');
    }

    // ==================== VISUALIZAÇÃO (VU + EQ) ====================
    function startVisualization() {
        if (animationFrameId) cancelAnimationFrame(animationFrameId);
        function loop() {
            updateVUMeter();
            drawEqualizer();
            animationFrameId = requestAnimationFrame(loop);
        }
        loop();
    }

    function stopVisualization() {
        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
        }
        // Resetar VU
        vuBarL.style.width = '0%';
        vuBarR.style.width = '0%';
        vuPeakL.textContent = '-∞';
        vuPeakR.textContent = '-∞';
        // Limpar equalizador
        ctxEqualizer.clearRect(0, 0, equalizerCanvas.width, equalizerCanvas.height);
    }

    function updateVUMeter() {
        if (!analyserLeft || !analyserRight) return;
        const bufferLength = analyserLeft.frequencyBinCount;
        const dataL = new Uint8Array(bufferLength);
        const dataR = new Uint8Array(bufferLength);
        analyserLeft.getByteTimeDomainData(dataL);
        analyserRight.getByteTimeDomainData(dataR);
        
        const rmsL = calculateRMS(dataL);
        const rmsR = calculateRMS(dataR);
        
        updateVUBar(vuBarL, vuPeakL, rmsL);
        updateVUBar(vuBarR, vuPeakR, rmsR);
        
        // Guardar valores para detecção de silêncio
        window.__nativa_rms_L = rmsL;
        window.__nativa_rms_R = rmsR;
    }

    function calculateRMS(data) {
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
            const normalized = (data[i] - 128) / 128;
            sum += normalized * normalized;
        }
        return Math.sqrt(sum / data.length);
    }

    function updateVUBar(barElement, peakElement, rms) {
        const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
        const clampedDB = Math.max(-60, Math.min(db, 0));
        const percent = (clampedDB + 60) / 60 * 100; // -60dB -> 0%, 0dB -> 100%
        barElement.style.width = Math.min(100, Math.max(0, percent)) + '%';
        peakElement.textContent = db === -Infinity ? '-∞' : db.toFixed(1) + ' dB';
    }

    function drawEqualizer() {
        if (!analyserEQ) return;
        const canvas = equalizerCanvas;
        const ctx = ctxEqualizer;
        const width = canvas.width = canvas.clientWidth || window.innerWidth;
        const height = canvas.height = 180;
        ctx.clearRect(0, 0, width, height);
        
        const bufferLength = analyserEQ.frequencyBinCount; // 64
        const dataArray = new Uint8Array(bufferLength);
        analyserEQ.getByteFrequencyData(dataArray);
        
        const barCount = 32; // mostrar 32 barras
        const barWidth = width / barCount - 1;
        const step = Math.floor(bufferLength / barCount);
        
        for (let i = 0; i < barCount; i++) {
            const index = i * step;
            const value = dataArray[index] / 255.0; // normalizado 0-1
            const barHeight = Math.max(2, value * height * 0.9);
            
            // Cor baseada na região de frequência
            let color;
            if (i < 10) color = 'rgba(26, 188, 156,'; // graves verde
            else if (i < 22) color = 'rgba(52, 152, 219,'; // médios azul
            else color = 'rgba(155, 89, 182,'; // agudos roxo
            
            const alpha = 0.5 + value * 0.5;
            ctx.fillStyle = color + alpha + ')';
            ctx.fillRect(i * (barWidth + 1), height - barHeight, barWidth, barHeight);
            
            // Brilho no topo
            ctx.fillStyle = color + (alpha * 0.8) + ')';
            ctx.fillRect(i * (barWidth + 1), height - barHeight, barWidth, 3);
        }
    }

    // ==================== DETECÇÃO DE SILÊNCIO E RECONEXÃO ====================
    function startSilenceDetection() {
        clearSilenceDetection();
        silenceTimer = setInterval(() => {
            const rmsL = window.__nativa_rms_L || 0;
            const rmsR = window.__nativa_rms_R || 0;
            const avgRMS = (rmsL + rmsR) / 2;
            
            if (avgRMS < SILENCE_THRESHOLD && playerState === PlayerState.PLAYING) {
                if (!silenceStart) silenceStart = Date.now();
                const silentDuration = Date.now() - silenceStart;
                if (silentDuration >= SILENCE_DURATION) {
                    console.warn('[Nativa FM] Silêncio detectado por mais de 10s, reconectando...');
                    triggerReconnect();
                    silenceStart = null;
                }
            } else {
                silenceStart = null;
            }
        }, 2000);
    }

    function clearSilenceDetection() {
        if (silenceTimer) {
            clearInterval(silenceTimer);
            silenceTimer = null;
        }
        silenceStart = null;
    }

    function triggerReconnect() {
        if (playerState === PlayerState.RECONNECTING) return;
        setPlayerState(PlayerState.RECONNECTING);
        stopVisualization();
        clearSilenceDetection();
        audioEl.pause();
        
        const backoff = RECONNECT_BACKOFF[Math.min(reconnectAttempt, RECONNECT_BACKOFF.length - 1)];
        console.log(`[Nativa FM] Tentativa de reconexão em ${backoff/1000}s (tentativa ${reconnectAttempt + 1})`);
        reconnectAttempt++;
        
        setTimeout(() => {
            audioEl.src = STREAM_URL;
            audioEl.load();
            audioEl.play().then(() => {
                console.log('[Nativa FM] Reconexão bem-sucedida.');
                reconnectAttempt = 0;
                setPlayerState(PlayerState.PLAYING);
                startVisualization();
                startSilenceDetection();
                connectMetadataSSE();
            }).catch(err => {
                console.error('[Nativa FM] Falha na reconexão:', err);
                if (reconnectAttempt < RECONNECT_BACKOFF.length) {
                    triggerReconnect();
                } else {
                    setPlayerState(PlayerState.ERROR);
                    reconnectAttempt = 0;
                }
            });
        }, backoff);
    }

    // Eventos de erro do elemento audio
    audioEl.addEventListener('error', (e) => {
        console.error('[Nativa FM] Erro no elemento de áudio:', audioEl.error);
        if (playerState === PlayerState.PLAYING) {
            triggerReconnect();
        } else {
            setPlayerState(PlayerState.ERROR);
        }
    });
    audioEl.addEventListener('waiting', () => {
        if (playerState === PlayerState.PLAYING) {
            setPlayerState(PlayerState.BUFFERING);
        }
    });
    audioEl.addEventListener('playing', () => {
        if (playerState === PlayerState.BUFFERING || playerState === PlayerState.RECONNECTING) {
            setPlayerState(PlayerState.PLAYING);
        }
    });

    // ==================== METADADOS SSE ====================
    function connectMetadataSSE() {
        disconnectMetadataSSE();
        try {
            eventSource = new EventSource(METADATA_SSE);
            eventSource.onmessage = function(e) {
                try {
                    const data = JSON.parse(e.data);
                    if (data && data.title) {
                        updateMetadata(data.title);
                        console.log('[Nativa FM] Metadata recebida:', data.title);
                    }
                } catch (err) {
                    // Ignorar erros de parse
                }
            };
            eventSource.onerror = function() {
                console.warn('[Nativa FM] Erro na conexão SSE, tentando reconectar automaticamente...');
                // EventSource tenta reconectar automaticamente
            };
            console.log('[Nativa FM] Conectado ao SSE de metadados.');
        } catch (e) {
            console.error('[Nativa FM] Falha ao conectar SSE:', e);
        }
    }

    function disconnectMetadataSSE() {
        if (eventSource) {
            eventSource.close();
            eventSource = null;
        }
    }

    function updateMetadata(titleString) {
        // Formato comum: "Artista - Música" ou apenas "Música"
        const parts = titleString.split(' - ');
        let artist = '';
        let song = titleString;
        if (parts.length >= 2) {
            artist = parts[0].trim();
            song = parts.slice(1).join(' - ').trim();
        }
        currentSong.textContent = song || 'Tocando ao vivo';
        currentArtist.textContent = artist || '';
        metaTitle.textContent = song || 'Tocando ao vivo';
        metaArtist.textContent = artist || '';
        document.title = artist ? `${artist} - ${song} | Nativa FM 98.7` : `${song} | Nativa FM 98.7`;
    }

    // ==================== EVENT LISTENERS ====================
    function togglePlay() {
        if (playerState === PlayerState.PLAYING || playerState === PlayerState.LOADING || playerState === PlayerState.BUFFERING || playerState === PlayerState.RECONNECTING) {
            stopPlayback();
        } else {
            startPlayback();
        }
    }

    playPauseBtn.addEventListener('click', togglePlay);
    mainPlayBtn.addEventListener('click', togglePlay);
    interactionBtn.addEventListener('click', () => {
        hideInteractionOverlay();
        startPlayback();
    });

    // Tentar autoplay na carga
    window.addEventListener('DOMContentLoaded', () => {
        // Pequeno delay para garantir que tudo carregou
        setTimeout(() => {
            startPlayback();
        }, 500);
    });

    // Redimensionar canvas equalizador
    window.addEventListener('resize', () => {
        equalizerCanvas.width = equalizerCanvas.clientWidth || window.innerWidth;
    });

    // ==================== LIMPEZA ====================
    window.addEventListener('beforeunload', () => {
        stopVisualization();
        clearSilenceDetection();
        disconnectMetadataSSE();
        if (audioContext && audioContext.state !== 'closed') {
            audioContext.close();
        }
    });

    console.log('[Nativa FM] Sistema inicializado. Aguardando interação ou autoplay...');
})();