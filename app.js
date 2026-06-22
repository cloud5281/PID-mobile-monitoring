import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, onValue, onChildAdded, onChildChanged, onChildRemoved, set, get, update, push, remove } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { Chart, registerables } from 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/+esm';
import zoomPlugin from 'https://cdn.jsdelivr.net/npm/chartjs-plugin-zoom@2.0.1/+esm';

Chart.register(...registerables, zoomPlugin);

const Config = (() => {
    const urlParams = new URLSearchParams(window.location.search);
    const firebaseId = urlParams.get('id') || "real-time-gps-84c8a"; 
    const projectPath = urlParams.get('path') || "test_project";
    if (!firebaseId || !projectPath) {
        alert("網址參數錯誤");
    } else {
        window.history.replaceState({}, document.title, window.location.pathname);
    }
    return {
        firebaseProjectId: firebaseId,
        apiKey: urlParams.get('key') || "AIzaSyCjPnL5my8NsG7XYCbABGh45KtKM9s4SlI",
        dbRootPath: projectPath, 
        wifiIp: "", gpsPort: "", concUnit: "", concPort: "",
        timeDelay: 0, 
        dbURL: urlParams.get('db') || null,
        ZOOM_LEVEL: 17, 
        COLORS: { GREEN: '#28a745', YELLOW: '#ffc107', ORANGE: '#fd7e14', RED: '#ff0000' }
    };
})();

class MapManager {
    constructor() {
        const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors'
        });

        const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
            attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community'
        });

        this.map = L.map('map', {
            center: [25.0330, 121.5654],
            zoom: Config.ZOOM_LEVEL,
            layers: [osmLayer],
            zoomControl: true
        });

        const baseMaps = {
            "一般地圖": osmLayer,
            "衛星地圖": satelliteLayer
        };
        L.control.layers(baseMaps, null, { position: 'bottomright' }).addTo(this.map);

        this.marker = L.marker([0, 0], { 
            icon: L.icon({
                iconUrl: './image/man-walking.png',
                iconSize: [40, 40], iconAnchor: [20, 38], popupAnchor: [0, -40]
            }) 
        }).addTo(this.map);
        
        this.pathLine = L.polyline([], {color: 'blue', weight: 4}); 
        this.historyLayer = L.layerGroup().addTo(this.map);
        this.coordsArray = [];
        
        this.timestampToLayer = new Map();
        this.lastHighlightedLayer = null;
        this.isSwitchingPoint = false;
        
        this.selectedPointData = null; 
        this.eventsByTime = {}; 
        
        this.eventPins = new Map(); 

        this.pointRadius = 3;

        this.sharedTooltip = L.tooltip({
            direction: 'top',
            className: 'custom-tooltip',
            offset: [0, -8],
            sticky: true,
            opacity: 0.95
        });

        this.sharedPopup = L.popup({
            offset: [0, -5],
            closeButton: true,
            autoClose: true,
            closeOnClick: true,
            autoPan: false 
        });

        this.map.on('popupclose', () => {
            if (this.isSwitchingPoint) return;
            this._resetHighlight();
        });
    }

    renderEventPin(eventData, getHistoryRecordFn) {
        if (!eventData.lat || !eventData.lon) return;

        let pin = this.eventPins.get(eventData.timestamp);
        if (!pin) {
            const icon = L.divIcon({
                html: '<div style="font-size: 28px; line-height: 1; text-shadow: 2px 2px 4px rgba(0,0,0,0.5); cursor: pointer; text-align: center;">📌</div>',
                className: 'custom-event-pin',
                iconSize: [30, 30],
                iconAnchor: [15, 30],
                popupAnchor: [0, -30]
            });

            pin = L.marker([eventData.lat, eventData.lon], { icon: icon, zIndexOffset: 1000 }).addTo(this.map);

            pin.on('click', (e) => {
                L.DomEvent.stopPropagation(e);
                const hData = getHistoryRecordFn(eventData.timestamp) || {
                    lat: eventData.lat, lon: eventData.lon, timestamp: eventData.timestamp, conc: '?', conc_unit: ''
                };
                this.focusOnPoint(hData);
            });

            this.eventPins.set(eventData.timestamp, pin);
        } else {
            pin.setLatLng([eventData.lat, eventData.lon]);
        }
    }

    removeEventPin(timestamp) {
        const pin = this.eventPins.get(timestamp);
        if (pin) {
            if (this.map.hasLayer(pin)) pin.remove();
            this.eventPins.delete(timestamp);
        }
    }

    setPointRadius(radius) {
        this.pointRadius = radius;
        this.historyLayer.eachLayer((layer) => {
            if (layer !== this.lastHighlightedLayer) {
                if (layer.setRadius) layer.setRadius(radius);
            }
        });
        if (this.lastHighlightedLayer) {
            const highlightSize = Math.max(10, this.pointRadius + 5);
            this.lastHighlightedLayer.setRadius(highlightSize);
        }
    }

    _resetHighlight() {
        if (this.lastHighlightedLayer) {
            this.lastHighlightedLayer.setStyle({
                stroke: false,
                radius: this.pointRadius, 
                fillOpacity: 0.9
            });
            this.lastHighlightedLayer = null;
        }
        this.selectedPointData = null; 
    }

    updateCurrentPosition(lat, lon, autoCenter) {
        if (lat !== null && lon !== null && lat !== undefined && lon !== undefined) {
            const pos = L.latLng(lat, lon);
            this.marker.setLatLng(pos);
            this.marker.setOpacity(1); 
            
            if (autoCenter) {
                const panel = document.querySelector('.info-panel');
                let offsetX = 0;
                if (panel && window.innerWidth > 768) {
                    offsetX = (panel.offsetWidth / 2) + 20;
                }
                const currentZoom = this.map.getZoom();
                const targetPoint = this.map.project(pos, currentZoom);
                const newCenterPoint = targetPoint.add([offsetX, 0]);
                const newCenterLatLng = this.map.unproject(newCenterPoint, currentZoom);

                this.map.panTo(newCenterLatLng);
            }
        } else {
            this.marker.setOpacity(0.5); 
        }
    }

    forceCenter(lat, lon) {
        if (lat !== null && lon !== null && lat !== undefined && lon !== undefined) {
            const pos = L.latLng(lat, lon);
            this.marker.setLatLng(pos);
            this.marker.setOpacity(1);
            
            const panel = document.querySelector('.info-panel');
            let offsetX = 0;
            if (panel && window.innerWidth > 768) {
                offsetX = (panel.offsetWidth / 2) + 20;
            }
            const currentZoom = this.map.getZoom();
            const targetPoint = this.map.project(pos, currentZoom);
            const newCenterPoint = targetPoint.add([offsetX, 0]);
            const newCenterLatLng = this.map.unproject(newCenterPoint, currentZoom);

            this.map.setView(newCenterLatLng, currentZoom);
        }
    }

    _getTooltipContent(data) {
        const unit = data.conc_unit || Config.concUnit || "";
        return `
            <div style="text-align: left; line-height: 1.5;">
                <span>⏰ 時間:</span> ${data.timestamp}<br>
                <span>📍 經緯:</span> ${data.lon.toFixed(6)}, ${data.lat.toFixed(6)}<br>
                <span>🧪 濃度:</span> ${data.conc} ${unit}<br>
            </div>`;
    }

    _getPopupContent(data) {
        const unit = data.conc_unit || Config.concUnit || "";
        let html = `
            <div style="text-align: left; line-height: 1.5; min-width: 200px; max-width: 280px;">
                <span>⏰ 時間:</span> ${data.timestamp}<br>
                <span>📍 經緯:</span> ${data.lon.toFixed(6)}, ${data.lat.toFixed(6)}<br>
                <span>🧪 濃度:</span> ${data.conc} ${unit}<br>
        `;
        
        const ev = this.eventsByTime[data.timestamp];
        
        html += `<div style="border-top: 1px solid rgba(255,255,255,0.3); margin-top: 8px; padding-top: 8px;">`;
        
        if (ev) {
            if (ev.note) html += `<div style="margin-bottom:8px; white-space:pre-wrap; font-size:13px; color:#ddd;">${ev.note}</div>`;
            
            let images = ev.images || (ev.image ? [ev.image] : []);
            if (images.length > 0) {
                html += `<div style="display:flex; flex-wrap:wrap; gap:4px; margin-bottom:8px;">`;
                images.forEach(imgB64 => {
                    html += `<img src="${imgB64}" onclick="document.dispatchEvent(new CustomEvent('open-lightbox', {detail: '${imgB64}'}))" style="width: 80px; height: 80px; object-fit: cover; border-radius: 4px; cursor: pointer; border: 1px solid rgba(255,255,255,0.2);">`;
                });
                html += `</div>`;
            }

            html += `<div style="display: flex; gap: 6px;">`;
            html += `<button onclick="document.dispatchEvent(new CustomEvent('edit-event-cmd', {detail: '${data.timestamp}'}))" style="flex: 2; padding:6px; font-size:13px; background:#4a4a4a; color:#fff; border:none; border-radius:4px; cursor:pointer;">編輯</button>`;
            html += `<button onclick="document.dispatchEvent(new CustomEvent('delete-event-cmd', {detail: '${data.timestamp}'}))" style="flex: 1; padding:6px; font-size:13px; background:#dc3545; color:#fff; border:none; border-radius:4px; cursor:pointer;">刪除</button>`;
            html += `</div>`;
            
        } else {
            html += `<button onclick="document.dispatchEvent(new CustomEvent('edit-event-cmd', {detail: '${data.timestamp}'}))" style="width:100%; padding:6px; font-size:13px; background:#28a745; color:#fff; border:none; border-radius:4px; cursor:pointer;">新增註記</button>`;
        }
        
        html += `</div></div>`;
        return html;
    }

    addHistoryPoint(data, getColorFn) {
        if (data.conc <= 0) return;

        if (data.lat !== undefined && data.lat !== null && data.lon !== undefined && data.lon !== null) {
            const pos = [data.lat, data.lon];
            this.coordsArray.push(pos);
            this.pathLine.setLatLngs(this.coordsArray);
            const color = getColorFn(data.conc);
            
            const hasEvent = !!this.eventsByTime[data.timestamp];
            
            const circle = L.circleMarker(pos, { 
                stroke: hasEvent, 
                color: hasEvent ? '#000' : undefined,
                weight: hasEvent ? 2 : 0,
                fillColor: color, 
                fillOpacity: 0.9, 
                radius: this.pointRadius
            });
            circle.concValue = data.conc;
            circle.timestamp = data.timestamp;

            if (data.timestamp) {
                this.timestampToLayer.set(data.timestamp, circle);
            }

            circle.on('mouseover', (e) => {
                if (this.map.hasLayer(this.sharedPopup)) return; 
                this.sharedTooltip.setContent(this._getTooltipContent(data));
                this.map.openTooltip(this.sharedTooltip, e.latlng);
            });

            circle.on('mouseout', () => {
                this.map.closeTooltip(this.sharedTooltip);
            });

            circle.on('click', (e) => {
                this.focusOnPoint(data);
            });

            this.historyLayer.addLayer(circle);
        }
    }

    updateVisibleHistory(cutoffTime) {
        this.historyLayer.eachLayer(layer => {
            if (layer.timestamp) {
                if (layer.timestamp <= cutoffTime) {
                    if (!this.map.hasLayer(layer)) {
                        this.historyLayer.addLayer(layer);
                    }
                    layer.setStyle({ opacity: 1, fillOpacity: 0.9 });
                } else {
                    layer.setStyle({ opacity: 0, fillOpacity: 0 });
                }
            }
        });

        this.eventPins.forEach((pin, timestamp) => {
            if (timestamp <= cutoffTime) {
                if (!this.map.hasLayer(pin)) pin.addTo(this.map);
            } else {
                if (this.map.hasLayer(pin)) pin.remove();
            }
        });
    }

    refreshColors(getColorFn) {
        this.historyLayer.eachLayer((layer) => {
            if (layer.concValue !== undefined) {
                if (layer === this.lastHighlightedLayer) return; 
                const hasEvent = !!this.eventsByTime[layer.timestamp];
                layer.setStyle({ 
                    fillColor: getColorFn(layer.concValue),
                    stroke: hasEvent,
                    color: hasEvent ? '#000' : undefined,
                    weight: hasEvent ? 2 : 0
                });
            }
        });
    }

    focusOnPoint(data) {
        if (!data || data.lat == null || data.lon == null) return;
        
        this.isSwitchingPoint = true;
        this.selectedPointData = data; 

        const targetLatLng = L.latLng(data.lat, data.lon);
        const panel = document.querySelector('.info-panel');
        let offsetX = 0;
        if (panel && window.innerWidth > 768) {
            offsetX = (panel.offsetWidth / 2) + 20;
        }
        const currentZoom = this.map.getZoom();
        const targetPoint = this.map.project(targetLatLng, currentZoom);
        const newCenterPoint = targetPoint.add([offsetX, 0]);
        const newCenterLatLng = this.map.unproject(newCenterPoint, currentZoom);

        this.map.panTo(newCenterLatLng, { animate: true, duration: 0.5 });
        this.map.closeTooltip(this.sharedTooltip);

        this._resetHighlight();

        const currentLayer = this.timestampToLayer.get(data.timestamp);
        if (currentLayer) {
            currentLayer.bringToFront();
            const highlightSize = Math.max(10, this.pointRadius + 5);
            currentLayer.setStyle({
                stroke: true,
                color: '#fff',
                weight: 3,
                radius: highlightSize,  
                fillOpacity: 1
            });
            this.lastHighlightedLayer = currentLayer;
        }

        setTimeout(() => {
            this.sharedPopup
                .setLatLng(targetLatLng)
                .setContent(this._getPopupContent(data)) 
                .openOn(this.map); 
            
            this.isSwitchingPoint = false;
        }, 100); 
    }
}

class UIManager {
    constructor(mapManager, db) {
        this.mapManager = mapManager;
        this.db = db;
        this.thresholds = { a: 50, b: 100, c: 150 };
        this.isRecording = false;
        this.chart = null; 
        this.sortedHistoryData = []; 
        this.chartTitleTextEl = null; 
        
        this.isPanning = false;
        this.lastPanX = 0;

        this.isPlaying = false;
        this.playbackInterval = null;
        this.isLiveMode = true; 

        this.eventsById = {};
        this.eventsByTime = {};
        this.currentEditEventId = null;
        this.targetLat = null;
        this.targetLon = null;
        this.targetTime = null;

        this.initDOM();
        this.setInterfaceMode('offline', "未連接 Controller", "gray", "offline");
        this.bindEvents();
        this.startClock();
        this.initChart();
    }

    cacheEvent(id, data) {
        this.eventsById[id] = data;
        this.eventsByTime[data.timestamp] = { id, ...data };
    }

    initDOM() {
        this.els = {
            controlBar: document.getElementById('bottom-control-bar'),
            time: document.getElementById('time'),
            path: document.getElementById('currentPath'),
            coords: document.getElementById('coords'),
            
            conc: document.getElementById('concentration'),
            
            statusDot: document.getElementById('status-dot'),
            statusText: document.getElementById('connection-text'),
            thresholdTitle: document.getElementById('threshold-title-text'),
            autoCenter: document.getElementById('autoCenter'),
            modal: document.getElementById('settings-modal'),
            btnOpenSettings: document.getElementById('btn-open-settings'),
            btnCloseModal: document.getElementById('btn-close-modal'),
            btnSaveBackend: document.getElementById('btn-save-backend'),
            backendInputs: {
                project: document.getElementById('set-project-id'),
                wifi_ip: document.getElementById('set-gps-ip'),
                port: document.getElementById('set-gps-port'),
                conc_port: document.getElementById('set-conc-port'),
                unit: document.getElementById('set-conc-unit'),
                time_delay: document.getElementById('set-time-delay')
            },
            btnStart: document.getElementById('btn-start'),
            btnUpload: document.getElementById('btn-upload'),
            btnDownload: document.getElementById('btn-download'),
            inputs: { a: document.getElementById('val-a'), b: document.getElementById('val-b'), c: document.getElementById('val-c') },
            displays: { a: document.getElementById('disp-a'), b: document.getElementById('disp-b'), c: document.getElementById('disp-c') },
            msgBox: document.getElementById('msg-box'),
            mainPanel: document.getElementById('main-panel'),
            toggleBtn: document.getElementById('panel-toggle-btn'),
            radiusSlider: document.getElementById('radius-slider'),
            radiusValue: document.getElementById('radius-value'),

            eventModal: document.getElementById('event-modal'),
            btnCloseEventModal: document.getElementById('btn-close-event-modal'),
            eventNote: document.getElementById('event-note'),
            eventPhoto: document.getElementById('event-photo'),
            eventPhotoPreviewContainer: document.getElementById('event-photo-preview-container'), 
            btnSaveEvent: document.getElementById('btn-save-event'),

            lightboxModal: document.getElementById('lightbox-modal'),
            lightboxImg: document.getElementById('lightbox-img'),
            btnCloseLightbox: document.getElementById('btn-close-lightbox')
        };
        
        this.eventImagesBase64 = []; 

        this.els.path.innerText = Config.dbRootPath;

        const oldHint = document.querySelector('.threshold-section .section-header small');
        if (oldHint) oldHint.style.display = 'none';

        if (this.els.thresholdTitle) {
            const unitText = Config.concUnit ? ` (${Config.concUnit})` : "";
            this.els.thresholdTitle.innerHTML = 
                `濃度閾值設定${unitText} <span style="font-size: 11px; color: #999; font-weight: normal;">(Enter 儲存)</span>`;
        }

        this.updateThresholdDisplay();
        this.els.inputs.a.value = this.thresholds.a;
        this.els.inputs.b.value = this.thresholds.b;
        this.els.inputs.c.value = this.thresholds.c;
        if (this.els.autoCenter) this.els.autoCenter.checked = true;
        this.injectChartUI();

        if (window.innerWidth <= 768 && this.els.mainPanel) {
            this.els.mainPanel.classList.add('collapsed');
        }
    }

    injectChartUI() {
        const thresholdSection = document.querySelector('.threshold-section');
        if (!thresholdSection) return;

        const container = document.createElement('div');
        container.style.marginBottom = '12px'; 
        container.style.paddingBottom = '12px';
        container.style.borderBottom = '1px solid #eee'; 
        
        const headerDiv = document.createElement('div');
        headerDiv.className = 'section-header'; 
        headerDiv.style.display = 'flex';
        headerDiv.style.alignItems = 'center';
        
        const titleContainer = document.createElement('div');
        const titleSpan = document.createElement('span');
        titleSpan.innerText = "歷史濃度趨勢"; 
        this.chartTitleTextEl = titleSpan;
        titleContainer.appendChild(titleSpan);

        const noteSpan = document.createElement('span');
        noteSpan.innerText = " (點選跳轉)";
        noteSpan.style.fontSize = "11px";
        noteSpan.style.color = "#999";
        noteSpan.style.fontWeight = "normal";
        titleContainer.appendChild(noteSpan);

        headerDiv.appendChild(titleContainer);

        const resetBtn = document.createElement('button');
        resetBtn.className = "btn-icon"; 
        resetBtn.style.marginLeft = "auto"; 
        resetBtn.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="icon-svg">
                <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
            </svg>
            重置縮放比例
        `;
        resetBtn.onclick = () => {
            if (this.chart) this.chart.resetZoom();
        };
        headerDiv.appendChild(resetBtn);

        container.appendChild(headerDiv);

        const maxRowDiv = document.createElement('div');
        maxRowDiv.style.display = 'flex';
        maxRowDiv.style.alignItems = 'center';
        maxRowDiv.style.marginTop = '-4px'; 
        maxRowDiv.style.marginBottom = '8px'; 
        
        const maxSpan = document.createElement('span');
        maxSpan.id = 'conc-max';
        maxSpan.style.fontSize = '12px';
        maxSpan.style.color = '#333';
        maxSpan.style.fontWeight = 'bold'; 
        maxSpan.style.display = 'none';
        
        maxRowDiv.appendChild(maxSpan);
        container.appendChild(maxRowDiv);
        
        const canvasWrapper = document.createElement('div');
        canvasWrapper.style.position = 'relative';
        canvasWrapper.style.height = '150px'; 
        canvasWrapper.style.width = '100%';
        const canvas = document.createElement('canvas');
        canvas.id = 'concChart';
        canvasWrapper.appendChild(canvas);
        container.appendChild(canvasWrapper);

        const playbackControls = document.createElement('div');
        playbackControls.style.display = 'flex';
        playbackControls.style.alignItems = 'center';
        playbackControls.style.marginTop = '8px';
        playbackControls.style.gap = '8px';

        const playBtn = document.createElement('button');
        playBtn.id = 'btn-playback-toggle';
        playBtn.className = 'btn-icon';
        playBtn.style.minWidth = '30px';
        playBtn.style.justifyContent = 'center';
        playBtn.innerHTML = '▶'; 
        
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.id = 'playback-slider';
        slider.style.flex = '1';
        slider.min = 0;
        slider.value = 0;
        slider.step = 1;
        slider.style.cursor = 'pointer';
        slider.style.height = '4px';

        const timeLabel = document.createElement('span');
        timeLabel.id = 'playback-time';
        timeLabel.style.fontSize = '12px';
        timeLabel.style.fontFamily = 'monospace';
        timeLabel.style.color = '#555';
        timeLabel.style.minWidth = '50px';
        timeLabel.style.textAlign = 'right';
        timeLabel.innerText = '-00:00';

        playbackControls.appendChild(playBtn);
        playbackControls.appendChild(slider);
        playbackControls.appendChild(timeLabel);
        
        container.appendChild(playbackControls);

        thresholdSection.insertBefore(container, thresholdSection.firstChild);
        
        this.chartCanvas = canvas;
        this.els.playbackPanel = playbackControls; 
        this.els.concMax = maxSpan; 

        this.bindPlaybackEvents(playBtn, slider, timeLabel);
    }

    bindPlaybackEvents(btn, slider, label) {
        this.els.playbackBtn = btn;
        this.els.playbackSlider = slider;
        this.els.playbackLabel = label;

        slider.addEventListener('input', (e) => {
            const idx = parseInt(e.target.value);
            this.isLiveMode = (idx >= parseInt(slider.max)); 
            this.renderPlaybackFrame(idx);
        });

        btn.addEventListener('click', () => {
            if (this.isPlaying) {
                this.stopPlayback();
            } else {
                this.startPlayback();
            }
        });
    }

    startPlayback() {
        if (!this.sortedHistoryData || this.sortedHistoryData.length === 0) return;
        
        this.isPlaying = true;
        this.els.playbackBtn.innerHTML = '❚❚'; 
        this.isLiveMode = false;

        if (parseInt(this.els.playbackSlider.value) >= parseInt(this.els.playbackSlider.max)) {
            this.els.playbackSlider.value = 0;
        }

        this.playbackInterval = setInterval(() => {
            let current = parseInt(this.els.playbackSlider.value);
            let max = parseInt(this.els.playbackSlider.max);
            
            if (current < max) {
                current++;
                this.els.playbackSlider.value = current;
                this.renderPlaybackFrame(current);
            } else {
                this.stopPlayback();
                this.isLiveMode = true; 
            }
        }, 100); 
    }

    stopPlayback() {
        this.isPlaying = false;
        this.els.playbackBtn.innerHTML = '▶';
        if (this.playbackInterval) {
            clearInterval(this.playbackInterval);
            this.playbackInterval = null;
        }
    }

    renderPlaybackFrame(index) {
        if (!this.sortedHistoryData || !this.sortedHistoryData[index]) return;

        const record = this.sortedHistoryData[index];
        const lastRecord = this.sortedHistoryData[this.sortedHistoryData.length - 1];

        if (this.els.playbackLabel) {
            const parseTime = (t) => new Date(t.replace(/-/g, '/')).getTime();
            const currentMs = parseTime(record.timestamp);
            const endMs = parseTime(lastRecord.timestamp);
            const diffSec = Math.max(0, Math.floor((endMs - currentMs) / 1000));

            const mm = Math.floor(diffSec / 60).toString().padStart(2, '0');
            const ss = (diffSec % 60).toString().padStart(2, '0');
            this.els.playbackLabel.innerText = `-${mm}:${ss}`;
        }

        this.mapManager.updateVisibleHistory(record.timestamp);
        
        if (record.lat && record.lon) {
            this.mapManager.updateCurrentPosition(record.lat, record.lon, this.els.autoCenter.checked);
        }

        if (this.chart) {
            const slicedData = this.sortedHistoryData.slice(0, index + 1);
            const values = slicedData.map(d => d.conc);
            
            let currentMax = 0;
            if (values.length > 0) currentMax = Math.max(...values);

            if (this.els.concMax) {
                let unit = Config.concUnit || "";
                if (!unit && slicedData.length > 0) {
                    unit = slicedData[slicedData.length - 1].conc_unit || "";
                }
                this.els.concMax.innerText = `Max: ${currentMax} ${unit}`;
                this.els.concMax.style.display = "block";
            }

            this.chart.data.labels = slicedData.map(d => d.timestamp.split(' ')[1]);
            this.chart.data.datasets[0].data = values;
            this.chart.update('none'); 
        }
    }

    initChart() {
        if (!this.chartCanvas) return;
        const ctx = this.chartCanvas.getContext('2d');
        const getColor = (val) => this.getColor(val);

        const isMobile = window.innerWidth <= 768;

        this.chart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [{
                    label: '濃度',
                    data: [],
                    showLine: false,
                    borderWidth: 2,
                    tension: 0.3,
                    fill: false,
                    segment: {
                        borderColor: ctx => getColor(this.sortedHistoryData[ctx.p0DataIndex]?.conc)
                    },
                    pointRadius: 3,
                    pointHitRadius: 25, 
                    pointHoverRadius: 8,
                    pointBorderColor: '#fff',
                    pointBorderWidth: 0,
                    pointBackgroundColor: (context) => {
                        const val = context.dataset.data[context.dataIndex];
                        return getColor(val);
                    }
                }]
            },
            options: {
                animation: false,
                responsive: true, 
                maintainAspectRatio: false, 
                scales: { 
                    x: { display: true, ticks: { display: true, autoSkip: true, maxTicksLimit: 6, minRotation: 25, maxRotation: 45 } }, 
                    y: { beginAtZero: true } 
                },
                interaction: { mode: 'nearest', axis: 'x', intersect: false }, 
                plugins: {
                    legend: { display: false },
                    zoom: { 
                        pan: {
                            enabled: true,
                            mode: 'x',
                            threshold: 10,
                            modifierKey: isMobile ? null : 'ctrl', 
                        },
                        zoom: { 
                            wheel: { enabled: true },
                            pinch: { enabled: true }, 
                            drag: {
                                enabled: !isMobile, 
                                backgroundColor: 'rgba(54, 162, 235, 0.3)',
                                borderColor: 'rgba(54, 162, 235, 1)',
                                borderWidth: 1,
                                mode: 'x',
                            },
                            mode: 'x', 
                        } 
                    }
                },
                onClick: (e, elements) => {
                    if (elements.length > 0) {
                        const index = elements[0].index;
                        const record = this.sortedHistoryData[index];
                        if (record && record.lat) this.mapManager.focusOnPoint(record);
                    }
                }
            }
        });

        this.chartCanvas.addEventListener('mousedown', (e) => {
            if (e.button === 1) { 
                e.preventDefault(); 
                this.isPanning = true;
                this.lastPanX = e.clientX;
                this.chartCanvas.style.cursor = 'grabbing'; 
            }
        });

        this.chartCanvas.addEventListener('mousemove', (e) => {
            if (this.isPanning && this.chart) {
                const deltaX = e.clientX - this.lastPanX;
                this.chart.pan({x: deltaX}, undefined, 'default'); 
                this.lastPanX = e.clientX;
            }
        });

        const stopPanning = (e) => {
            if (this.isPanning && e.button === 1) {
                this.isPanning = false;
                this.chartCanvas.style.cursor = 'default';
            }
        };

        window.addEventListener('mouseup', stopPanning);
    }

    updateChart(historyData) {
        if (this.isPlaying) return;

        if (!this.chart || !historyData) return;
        
        const rawSorted = Object.values(historyData).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        this.sortedHistoryData = rawSorted.filter(d => d.conc > 0);

        const allValues = this.sortedHistoryData.map(d => d.conc);
        
        if (this.els.playbackSlider) {
            this.els.playbackSlider.max = this.sortedHistoryData.length - 1;
            if (this.isLiveMode) {
                this.els.playbackSlider.value = this.sortedHistoryData.length - 1;
                if (this.els.playbackLabel) {
                    this.els.playbackLabel.innerText = "-00:00";
                }
            }
        }

        let globalMax = 0;
        if (allValues.length > 0) {
            globalMax = Math.max(...allValues);
        }
        
        this.chart.options.scales.y.suggestedMax = (globalMax > 0) ? globalMax * 1.05 : 10;
        delete this.chart.options.scales.y.max;
        this.chart.options.scales.y.min = 0;

        if (this.els.concMax) {
            if (globalMax > 0) {
                let unit = Config.concUnit || "";
                if (!unit && this.sortedHistoryData.length > 0) {
                    unit = this.sortedHistoryData[this.sortedHistoryData.length - 1].conc_unit || "";
                }
                this.els.concMax.innerText = `Max: ${globalMax} ${unit}`;
                this.els.concMax.style.display = "block";
            } else {
                this.els.concMax.style.display = "none";
            }
        }

        if (this.isLiveMode) {
            this.chart.data.labels = this.sortedHistoryData.map(d => d.timestamp.split(' ')[1]); 
            this.chart.data.datasets[0].data = allValues;
            this.chart.update('none');
            
            if (this.sortedHistoryData.length > 0) {
                const lastTs = this.sortedHistoryData[this.sortedHistoryData.length - 1].timestamp;
                this.mapManager.updateVisibleHistory(lastTs);
            }
        }
    }

    syncConfigFromBackend(data) {
        if (!data) return;
        Config.wifiIp = data.wifi_ip || ""; 
        Config.gpsPort = data.gps_port || ""; 
        Config.concUnit = data.conc_unit || "";
        Config.concPort = data.conc_port || "";
        Config.timeDelay = data.time_delay !== undefined ? data.time_delay : 0; 
        
        if (!this.els.modal.classList.contains('hidden')) this.fillSettingsInputs();
        if (this.chartTitleTextEl) this.chartTitleTextEl.innerText = `歷史濃度趨勢${Config.concUnit ? ` (${Config.concUnit})` : ""}`;
        
        if (this.els.thresholdTitle) {
            const unitText = Config.concUnit ? ` (${Config.concUnit})` : "";
            this.els.thresholdTitle.innerHTML = 
                `濃度閾值設定${unitText} <span style="font-size: 11px; color: #999; font-weight: normal;">(Enter 儲存)</span>`;
        }
    }

    syncThresholdsFromBackend(data) {
        if (data) {
            this.thresholds = { a: parseFloat(data.a), b: parseFloat(data.b), c: parseFloat(data.c) };
        } else {
            this.saveThresholdSettings(true); return; 
        }
        if (document.activeElement !== this.els.inputs.a && document.activeElement !== this.els.inputs.b && document.activeElement !== this.els.inputs.c) {
            this.els.inputs.a.value = this.thresholds.a;
            this.els.inputs.b.value = this.thresholds.b;
            this.els.inputs.c.value = this.thresholds.c;
        }
        this.updateThresholdDisplay();
        this.mapManager.refreshColors(this.getColor.bind(this));
        
        if (this.chart) {
            this.chart.update('none');
        }
    }
    updateThresholdDisplay() { this.els.displays.a.innerText = this.thresholds.a; this.els.displays.b.innerText = this.thresholds.b; this.els.displays.c.innerText = this.thresholds.c; }
    
    fillSettingsInputs() { 
        this.els.backendInputs.project.value = Config.dbRootPath; 
        this.els.backendInputs.wifi_ip.value = Config.wifiIp; 
        this.els.backendInputs.port.value = Config.gpsPort; 
        this.els.backendInputs.unit.value = Config.concUnit; 
        this.els.backendInputs.time_delay.value = Config.timeDelay; 
        
        if (Config.concPort) {
            let exists = false;
            for (let i = 0; i < this.els.backendInputs.conc_port.options.length; i++) {
                if (this.els.backendInputs.conc_port.options[i].value === Config.concPort) {
                    exists = true; break;
                }
            }
            if (!exists) {
                const opt = document.createElement('option');
                opt.value = Config.concPort;
                opt.innerText = Config.concPort + " (目前設定)";
                this.els.backendInputs.conc_port.appendChild(opt);
            }
            this.els.backendInputs.conc_port.value = Config.concPort;
        }
    }

    renderPreviewContainer() {
        this.els.eventPhotoPreviewContainer.innerHTML = '';
        this.eventImagesBase64.forEach((b64, index) => {
            const wrapper = document.createElement('div');
            wrapper.style.position = 'relative';
            wrapper.style.width = '65px';
            wrapper.style.height = '65px';
            
            const img = document.createElement('img');
            img.src = b64;
            img.style.width = '100%';
            img.style.height = '100%';
            img.style.objectFit = 'cover';
            img.style.borderRadius = '4px';
            img.style.cursor = 'pointer';
            img.onclick = () => {
                document.dispatchEvent(new CustomEvent('open-lightbox', {detail: b64}));
            };

            const delBtn = document.createElement('div');
            delBtn.innerHTML = '×';
            delBtn.style.position = 'absolute';
            delBtn.style.top = '-5px';
            delBtn.style.right = '-5px';
            delBtn.style.background = 'red';
            delBtn.style.color = 'white';
            delBtn.style.borderRadius = '50%';
            delBtn.style.width = '20px';
            delBtn.style.height = '20px';
            delBtn.style.textAlign = 'center';
            delBtn.style.lineHeight = '18px';
            delBtn.style.cursor = 'pointer';
            delBtn.style.fontSize = '16px';
            delBtn.style.fontWeight = 'bold';
            delBtn.onclick = () => {
                this.eventImagesBase64.splice(index, 1);
                this.renderPreviewContainer();
            };

            wrapper.appendChild(img);
            wrapper.appendChild(delBtn);
            this.els.eventPhotoPreviewContainer.appendChild(wrapper);
        });
    }

    openModalForEdit(id, data) {
        this.currentEditEventId = id;
        this.els.eventNote.value = data.note || '';
        
        this.eventImagesBase64 = data.images ? [...data.images] : (data.image ? [data.image] : []);
        this.renderPreviewContainer();
        
        this.els.eventPhoto.value = ''; 
        
        this.els.btnSaveEvent.disabled = false;
        this.els.btnSaveEvent.innerText = `儲存變更`;
        this.els.eventModal.classList.remove('hidden');
    }

    openModalForNew(timeLabel) {
        this.currentEditEventId = null;
        this.els.eventNote.value = '';
        this.els.eventPhoto.value = '';
        this.eventImagesBase64 = [];
        this.renderPreviewContainer();
        this.els.btnSaveEvent.disabled = false;
        
        this.els.btnSaveEvent.innerText = `儲存註記`;
        this.els.eventModal.classList.remove('hidden');
    }

    bindEvents() {
        this.els.btnOpenSettings.addEventListener('click', () => { this.fillSettingsInputs(); this.els.modal.classList.remove('hidden'); });
        this.els.btnCloseModal.addEventListener('click', () => { this.els.modal.classList.add('hidden'); });
        
        this.els.btnSaveBackend.addEventListener('click', () => {
            const p = this.els.backendInputs.project.value.trim(); 
            const i = this.els.backendInputs.wifi_ip.value.trim(); 
            const pt = this.els.backendInputs.port.value.trim(); 
            const u = this.els.backendInputs.unit.value.trim(); 
            const td = this.els.backendInputs.time_delay ? this.els.backendInputs.time_delay.value.trim() : ""; 
            const cp = this.els.backendInputs.conc_port ? this.els.backendInputs.conc_port.value : "";
            
            const updateData = {}; 
            if (p) updateData.project_name = p; 
            if (i) updateData.wifi_ip = i; 
            if (pt) updateData.gps_port = pt; 
            if (u) updateData.conc_unit = u; 
            if (td !== "") updateData.time_delay = parseFloat(td); 
            if (cp) updateData.conc_port = cp;
            
            if (Object.keys(updateData).length === 0) { alert("未輸入變更"); return; } 
            
            const btn = this.els.btnSaveBackend; 
            const originalText = btn.innerText; 
            btn.disabled = true; 
            const isProjectChanged = (updateData.project_name && updateData.project_name !== Config.dbRootPath); 
            
            if (isProjectChanged) { 
                btn.innerText = "切換中..."; 
                this.setInterfaceMode('switching', "切換中", "gray", "offline"); 
            } else { 
                btn.innerText = "更新中..."; 
            } 
            
            set(ref(this.db, `${Config.dbRootPath}/control/config_update`), updateData).then(() => { 
                if (isProjectChanged) { 
                    const url = new URL(window.location.href); 
                    url.searchParams.set('path', updateData.project_name); 
                    localStorage.setItem('is_switching', 'true'); 
                    window.location.href = url.toString(); 
                } else { 
                    btn.innerText = "已更新"; 
                    setTimeout(() => { 
                        this.els.modal.classList.add('hidden'); 
                        btn.disabled = false; 
                        btn.innerText = originalText; 
                    }, 800); 
                } 
            }).catch((err) => { 
                alert("更新失敗: " + err); 
                btn.disabled = false; 
                btn.innerText = originalText; 
                if (isProjectChanged) this.setInterfaceMode('idle', "更新失敗", "red", "timeout"); 
            }); 
        });
        
        Object.values(this.els.inputs).forEach(input => {
            input.addEventListener('blur', () => this.saveThresholdSettings());
            input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { input.blur(); this.saveThresholdSettings(); } });
        });

        if (this.els.radiusSlider) {
            this.els.radiusSlider.addEventListener('input', (e) => {
                const val = parseInt(e.target.value);
                this.els.radiusValue.innerText = val;
                this.mapManager.setPointRadius(val);
            });
        }

        Object.values(this.els.backendInputs).forEach(input => {
            if (input) {
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        input.blur();
                        this.els.btnSaveBackend.click(); 
                    }
                });
            }
        });

        this.els.btnStart.addEventListener('click', () => this.toggleRecordingCommand());
        this.els.btnUpload.addEventListener('click', () => this.triggerUploadProcess());
        this.els.btnDownload.addEventListener('click', () => this.downloadHistoryAsCSV());

        if (this.els.toggleBtn && this.els.mainPanel) {
            this.els.toggleBtn.addEventListener('click', () => {
                this.els.mainPanel.classList.toggle('collapsed');
            });
        }

        document.addEventListener('edit-event-cmd', (e) => {
            const timestamp = e.detail;
            const historyRecord = this.sortedHistoryData.find(d => d.timestamp === timestamp);
            
            if (historyRecord) {
                this.targetLat = historyRecord.lat;
                this.targetLon = historyRecord.lon;
                this.targetTime = historyRecord.timestamp;
            } else {
                this.targetTime = timestamp;
                this.targetLat = 0;
                this.targetLon = 0;
            }

            const existingEvent = this.eventsByTime[timestamp];
            if (existingEvent) {
                this.openModalForEdit(existingEvent.id, existingEvent);
            } else {
                this.openModalForNew(timestamp);
            }
        });

        document.addEventListener('delete-event-cmd', (e) => {
            const timestamp = e.detail;
            const existingEvent = this.eventsByTime[timestamp];
            if (existingEvent && existingEvent.id) {
                if (confirm('確定要直接刪除這筆註記嗎？刪除後無法復原。')) {
                    this.mapManager.map.closePopup(); 
                    remove(ref(this.db, `${Config.dbRootPath}/events/${existingEvent.id}`))
                        .catch(err => alert('刪除失敗: ' + err.message));
                }
            }
        });

        document.addEventListener('open-lightbox', (e) => {
            this.els.lightboxImg.src = e.detail;
            this.els.lightboxModal.classList.remove('hidden');
            this.els.lightboxModal.style.display = 'flex'; 
        });

        this.els.btnCloseLightbox.addEventListener('click', () => {
            this.els.lightboxModal.classList.add('hidden');
            this.els.lightboxModal.style.display = 'none';
        });
        this.els.lightboxModal.addEventListener('click', (e) => {
            if (e.target === this.els.lightboxModal) {
                this.els.lightboxModal.classList.add('hidden');
                this.els.lightboxModal.style.display = 'none';
            }
        });

        this.els.btnCloseEventModal.addEventListener('click', () => {
            this.els.eventModal.classList.add('hidden');
        });

        this.els.eventPhoto.addEventListener('change', (e) => this.handleEventPhoto(e));
        this.els.btnSaveEvent.addEventListener('click', () => this.saveEventMarker());
    }

    async handleEventPhoto(e) {
        const files = e.target.files;
        if (!files || files.length === 0) return;
        
        const btn = this.els.btnSaveEvent;
        const originalText = btn.innerText;
        btn.disabled = true;
        btn.innerText = '照片處理中...';

        const processFile = (file) => {
            return new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = (evt) => {
                    const img = new Image();
                    img.onload = () => {
                        const canvas = document.createElement('canvas');
                        const MAX_WIDTH = 1920; 
                        let width = img.width;
                        let height = img.height;
                        
                        if (width > MAX_WIDTH) {
                            height *= MAX_WIDTH / width;
                            width = MAX_WIDTH;
                        }
                        
                        canvas.width = width;
                        canvas.height = height;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(img, 0, 0, width, height);
                        
                        resolve(canvas.toDataURL('image/jpeg', 0.9));
                    };
                    img.src = evt.target.result;
                };
                reader.readAsDataURL(file);
            });
        };

        const newB64Images = await Promise.all(Array.from(files).map(processFile));
        this.eventImagesBase64.push(...newB64Images);
        
        this.renderPreviewContainer();
        this.els.eventPhoto.value = ''; 
        
        btn.disabled = false;
        btn.innerText = originalText;
    }

    saveEventMarker() {
        const note = this.els.eventNote.value.trim();
        if (!note && this.eventImagesBase64.length === 0) {
            alert('請輸入描述或至少上傳一張照片');
            return;
        }
        
        const btn = this.els.btnSaveEvent;
        const originalText = btn.innerText;
        btn.disabled = true;
        btn.innerText = '儲存中...';

        const eventData = {
            timestamp: this.targetTime,
            lat: this.targetLat,
            lon: this.targetLon,
            note: note,
            images: this.eventImagesBase64
        };

        const afterSaveAction = () => {
            this.els.eventModal.classList.add('hidden');
            const historyRecord = this.sortedHistoryData.find(d => d.timestamp === this.targetTime);
            if (historyRecord) {
                this.mapManager.focusOnPoint(historyRecord);
            } else {
                this.mapManager.focusOnPoint({ lat: this.targetLat, lon: this.targetLon, timestamp: this.targetTime, conc: '?', conc_unit: '' });
            }
        };

        if (this.currentEditEventId) {
            update(ref(this.db, `${Config.dbRootPath}/events/${this.currentEditEventId}`), eventData).then(() => {
                afterSaveAction();
            }).catch(err => {
                alert('更新失敗: ' + err.message);
                btn.disabled = false;
                btn.innerText = originalText;
            });
        } else {
            push(ref(this.db, `${Config.dbRootPath}/events`), eventData).then(() => {
                afterSaveAction();
            }).catch(err => {
                alert('建立失敗: ' + err.message);
                btn.disabled = false;
                btn.innerText = originalText;
            });
        }
    }

    updateRealtimeData(data) {
        if (!data) {
            this.els.coords.innerText = "-";
            this.els.conc.innerText = "-";
            return;
        }

        const status = data.status;

        if (status === 'GPS Lost' || status === 'All Lost' || status === 'V') {
            this.els.coords.innerText = "GPS 訊號中斷"; 
            this.els.coords.style.color = 'gray';
        } else if (data.lat !== undefined && data.lat !== null) {
            this.els.coords.innerText = `${data.lat.toFixed(6)}, ${data.lon.toFixed(6)}`;
            this.els.coords.style.color = 'black';
        } else {
            this.els.coords.innerText = "-";
            this.els.coords.style.color = 'black';
        }

        if (status === 'Conc Lost' || status === 'All Lost') {
            this.els.conc.innerText = "Conc 訊號中斷";
            this.els.conc.style.color = 'gray';
        } else if (data.conc !== undefined && data.conc !== null) {
            const unit = data.conc_unit || Config.concUnit || "";
            this.els.conc.innerText = `${data.conc} ${unit}`;
            this.els.conc.style.color = (data.conc >= this.thresholds.c) ? 'red' : 'black';
        } else {
            this.els.conc.innerText = "-";
            this.els.conc.style.color = 'black';
        }
    }

    setInterfaceMode(mode, statusText, statusColor = 'gray', statusClass = 'offline') {
        const thresholdInputs = Object.values(this.els.inputs);
        this.els.statusText.innerText = statusText;
        this.els.statusText.style.color = statusColor;
        this.els.statusDot.className = `status-dot st-${statusClass}`;

        this.els.btnStart.classList.add('hidden');
        this.els.btnUpload.classList.add('hidden');
        this.els.btnDownload.classList.add('hidden');
        this.els.btnOpenSettings.classList.add('hidden');
        this.els.btnOpenSettings.classList.remove('invisible');
        
        thresholdInputs.forEach(input => input.disabled = false);
        this.els.controlBar.style.display = 'none'; 

        switch (mode) {
            case 'recording':
                this.els.controlBar.style.display = ''; 
                this.els.btnStart.innerText = "停止";
                this.els.btnStart.classList.remove('hidden');
                this.els.btnStart.classList.add('btn-primary-large', 'btn-stop'); 
                
                this.els.btnOpenSettings.classList.remove('hidden'); 
                this.els.btnOpenSettings.classList.add('invisible'); 
                
                if (this.els.playbackPanel) this.els.playbackPanel.style.display = 'none';
                if (this.isPlaying) this.stopPlayback();
                this.isLiveMode = true; 
                this.isRecording = true;
                break;

            case 'idle':
                this.els.controlBar.style.display = '';
                this.els.btnStart.innerText = "開始";
                this.els.btnStart.classList.remove('hidden');
                this.els.btnStart.classList.remove('btn-stop');
                this.els.btnStart.classList.add('btn-primary-large');
                
                this.els.btnUpload.classList.remove('hidden');
                this.els.btnDownload.classList.remove('hidden');
                this.els.btnOpenSettings.classList.remove('hidden');
                
                if (this.els.playbackPanel) this.els.playbackPanel.style.display = 'flex';
                
                this.isRecording = false;
                break;

            case 'offline':
                this.els.controlBar.style.display = ''; 
                this.els.btnUpload.classList.remove('hidden'); 
                this.els.btnDownload.classList.remove('hidden'); 
                this.els.btnOpenSettings.classList.remove('hidden');
                
                if (this.els.playbackPanel) this.els.playbackPanel.style.display = 'flex';
                break;

            case 'switching':
                this.els.controlBar.style.display = 'none';
                this.els.btnOpenSettings.classList.add('hidden');
                thresholdInputs.forEach(input => input.disabled = true);
                break;
        }
    }

    triggerUploadProcess() { const input = document.createElement('input'); input.type = 'file'; input.accept = '.csv'; input.style.display = 'none'; input.onchange = (e) => { const file = e.target.files[0]; if (file) this.parseAndUploadCSV(file); }; document.body.appendChild(input); input.click(); document.body.removeChild(input); }
    parseAndUploadCSV(file) { const btn = this.els.btnUpload; const originalText = btn.innerText; btn.disabled = true; btn.innerText = "上傳中..."; let projectName = file.name.replace(/\.csv$/i, "").trim(); if (!projectName) { alert("檔名無效"); btn.disabled = false; btn.innerText = originalText; return; } const reader = new FileReader(); reader.onload = (e) => { try { const text = e.target.result; const lines = text.split(/\r?\n/); if (lines.length < 2) throw new Error("CSV 為空"); const uploadData = {}; let count = 0; let lastRecord = null; for (let i = 1; i < lines.length; i++) { const line = lines[i].trim(); if (!line) continue; const cols = line.split(','); if (cols.length < 4) continue; const record = { timestamp: cols[0].trim(), lat: parseFloat(cols[1]), lon: parseFloat(cols[2]), conc: parseFloat(cols[3]), conc_unit: cols[4] ? cols[4].trim() : "", status: cols[5] ? cols[5].trim() : "" }; if (!isNaN(record.lat) && !isNaN(record.lon)) { const key = `record_${Date.now()}_${i}`; uploadData[key] = record; lastRecord = record; count++; } } if (count === 0) throw new Error("無有效數據"); const updates = {}; updates[`${projectName}/history`] = uploadData; if (lastRecord) updates[`${projectName}/latest`] = lastRecord; update(ref(this.db), updates).then(() => { const isDiff = (projectName !== Config.dbRootPath); if (isDiff) { alert(`上傳成功，切換至: ${projectName}`); this.setInterfaceMode('switching', "切換中", "gray", "offline"); set(ref(this.db, `${Config.dbRootPath}/control/config_update`), { project_name: projectName }); const url = new URL(window.location.href); url.searchParams.set('path', projectName); localStorage.setItem('should_fit_bounds', 'true'); window.location.href = url.toString(); } else { localStorage.setItem('should_fit_bounds', 'true'); alert("上傳成功"); location.reload(); } }).catch(err => { alert("上傳失敗: " + err.message); btn.disabled = false; btn.innerText = originalText; }); } catch (err) { alert("解析失敗: " + err.message); btn.disabled = false; btn.innerText = originalText; } }; reader.readAsText(file); }
    async downloadHistoryAsCSV() { const btn = this.els.btnDownload; const originalText = btn.innerText; btn.disabled = true; btn.innerText = "下載中..."; try { const snapshot = await get(ref(this.db, `${Config.dbRootPath}/history`)); if (!snapshot.exists()) { alert("無歷史資料"); return; } const data = snapshot.val(); let csvContent = "\uFEFFTimestamp,Latitude,Longitude,Concentration,Unit,Status\n"; Object.values(data).forEach(row => { const t = row.timestamp || ""; const lat = row.lat || ""; const lon = row.lon || ""; const conc = row.conc || 0; const unit = row.conc_unit || Config.concUnit; const st = row.status || ""; csvContent += `${t},${lat},${lon},${conc},${unit},${st}\n`; }); const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' }); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `${Config.dbRootPath}.csv`; link.click(); URL.revokeObjectURL(url); } catch (error) { console.error(error); alert("下載失敗"); } finally { btn.disabled = false; btn.innerText = originalText; } }
    toggleRecordingCommand() { set(ref(this.db, `${Config.dbRootPath}/control/command`), this.isRecording ? "stop" : "start"); }
    startClock() { setInterval(() => this.els.time.innerText = new Date().toLocaleTimeString('zh-TW', { hour12: false }), 1000); }
    getColor(value) { if (value < this.thresholds.a) return Config.COLORS.GREEN; if (value < this.thresholds.b) return Config.COLORS.YELLOW; if (value < this.thresholds.c) return Config.COLORS.ORANGE; return Config.COLORS.RED; }
    
    saveThresholdSettings(isSilent = false) { 
        const { a: elA, b: elB, c: elC } = this.els.inputs;
        const msgBox = this.els.msgBox;
        [elA, elB, elC].forEach(el => el.classList.remove('input-error'));
        if (!isSilent) msgBox.innerText = "";

        const valA = parseFloat(elA.value);
        const valB = parseFloat(elB.value);
        const valC = parseFloat(elC.value);
        
        let error = null;
        if (isNaN(valA) || isNaN(valB) || isNaN(valC)) { error = "請填入完整數值"; } 
        else if (valA >= valB) { elA.classList.add('input-error'); error = "綠色閾值需小於黃色閾值"; } 
        else if (valB >= valC) { elB.classList.add('input-error'); error = "黃色閾值需小於橙色閾值"; }

        if (error) {
            if (!isSilent) { msgBox.innerText = error; msgBox.style.color = "red"; }
            return; 
        }

        set(ref(this.db, `${Config.dbRootPath}/settings/thresholds`), { a: valA, b: valB, c: valC })
            .then(() => {
                if (!isSilent) { msgBox.innerText = "設定已儲存"; msgBox.style.color = "green"; setTimeout(() => msgBox.innerText = "", 2000); }
            })
            .catch(err => {
                if (!isSilent) { msgBox.innerText = "儲存失敗"; msgBox.style.color = "red"; }
            });
    }
}

async function main() {
    const firebaseConfig = { apiKey: Config.apiKey, authDomain: `${Config.firebaseProjectId}.firebaseapp.com`, databaseURL: Config.dbURL || `https://${Config.firebaseProjectId}-default-rtdb.asia-southeast1.firebasedatabase.app`, projectId: Config.firebaseProjectId };
    const app = initializeApp(firebaseConfig);
    const db = getDatabase(app);
    const mapManager = new MapManager();
    const uiManager = new UIManager(mapManager, db);
    let backendState = 'offline';
    let lastGpsData = null;
    let lastValidPosition = null; 
    let hasInitialCentered = false; 

    onValue(ref(db, `${Config.dbRootPath}/status/available_ports`), (snapshot) => {
        const ports = snapshot.val() || [];
        const selectEl = document.getElementById('set-conc-port');
        if (selectEl) {
            const currentVal = selectEl.value || Config.concPort;
            selectEl.innerHTML = '';
            if (ports.length > 0) {
                ports.forEach(p => {
                    const opt = document.createElement('option');
                    opt.value = p;
                    opt.innerText = p;
                    selectEl.appendChild(opt);
                });
                
                let exists = ports.includes(currentVal);
                if (!exists && currentVal) {
                    const opt = document.createElement('option');
                    opt.value = currentVal;
                    opt.innerText = currentVal + " (目前設定)";
                    selectEl.appendChild(opt);
                }
                selectEl.value = currentVal;
            } else {
                const opt = document.createElement('option');
                opt.value = currentVal || "";
                opt.innerText = currentVal ? currentVal + " (未偵測到設備)" : "未偵測到設備";
                selectEl.appendChild(opt);
                selectEl.value = currentVal || "";
            }
        }
    });

    onValue(ref(db, `${Config.dbRootPath}/settings/current_config`), (snapshot) => { if (snapshot.val()) uiManager.syncConfigFromBackend(snapshot.val()); });
    onValue(ref(db, `${Config.dbRootPath}/settings/thresholds`), (snapshot) => { uiManager.syncThresholdsFromBackend(snapshot.val()); });
    
    onValue(ref(db, `${Config.dbRootPath}/history`), (snapshot) => { 
        if(snapshot.exists()) {
            const data = snapshot.val();
            uiManager.updateChart(data);
            
            const sorted = Object.values(data).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
            for (let i = sorted.length - 1; i >= 0; i--) {
                if (sorted[i].lat != null && sorted[i].lon != null) {
                    lastValidPosition = { lat: sorted[i].lat, lon: sorted[i].lon };
                    break;
                }
            }

            if (!hasInitialCentered && lastValidPosition) {
                mapManager.updateCurrentPosition(lastValidPosition.lat, lastValidPosition.lon, true);
                mapManager.map.setView([lastValidPosition.lat, lastValidPosition.lon], Config.ZOOM_LEVEL);
                hasInitialCentered = true; 
            }

            if (localStorage.getItem('should_fit_bounds') === 'true') { 
                if (lastValidPosition) {
                    mapManager.updateCurrentPosition(lastValidPosition.lat, lastValidPosition.lon, true);
                    mapManager.map.setZoom(Config.ZOOM_LEVEL);
                }
                localStorage.removeItem('should_fit_bounds'); 
            }
        }
    });

    onValue(ref(db, `${Config.dbRootPath}/status`), (snapshot) => {
        const data = snapshot.val();
        if (localStorage.getItem('is_switching') && data && (data.state === 'stopped' || data.state === 'active')) localStorage.removeItem('is_switching');
        
        if (!data || data.state === 'offline') {
            uiManager.setInterfaceMode('offline', "未連接 Controller", "gray", "offline");
            uiManager.updateRealtimeData({}); 
            return;
        }

        backendState = data.state;
        const msg = data.message || "未知狀態";

        switch (data.state) {
            case 'active':
                uiManager.setInterfaceMode('recording', msg, '#28a745', 'active');
                break;
            case 'gps_lost':
            case 'conc_lost':
            case 'all_lost':
            case 'connecting':
                uiManager.setInterfaceMode('recording', msg, '#ffc107', 'connecting');
                break;
            case 'timeout':
                uiManager.setInterfaceMode('idle', msg, '#dc3545', 'timeout');
                break;
            case 'stopped':
                uiManager.setInterfaceMode('idle', msg, 'gray', 'stopped');
                uiManager.updateRealtimeData({});
                break;
            case 'switching':
                uiManager.setInterfaceMode('switching', msg, 'gray', 'offline');
                break;
            default:
                uiManager.setInterfaceMode('offline', msg, 'gray', 'offline');
                break;
        }
    });

    onValue(ref(db, `${Config.dbRootPath}/latest`), (snapshot) => {
        const data = snapshot.val();
        if (data) {
            lastGpsData = data;
            if (data.lat != null && data.lon != null) {
                lastValidPosition = { lat: data.lat, lon: data.lon };
            }
            mapManager.updateCurrentPosition(data.lat, data.lon, document.getElementById('autoCenter').checked);
            if (backendState !== 'offline' && backendState !== 'stopped') {
                uiManager.updateRealtimeData(data);
            }
        }
    });

    onChildAdded(ref(db, `${Config.dbRootPath}/history`), (snapshot) => { if (snapshot.val()) mapManager.addHistoryPoint(snapshot.val(), uiManager.getColor.bind(uiManager)); });
    
    onChildAdded(ref(db, `${Config.dbRootPath}/events`), (snapshot) => { 
        if (snapshot.val()) {
            const id = snapshot.key;
            const data = snapshot.val();
            uiManager.cacheEvent(id, data);
            mapManager.eventsByTime[data.timestamp] = { id, ...data };
            
            mapManager.renderEventPin(data, (ts) => uiManager.sortedHistoryData.find(d => d.timestamp === ts));
            mapManager.refreshColors(uiManager.getColor.bind(uiManager));
            
            if (mapManager.selectedPointData && mapManager.selectedPointData.timestamp === data.timestamp) {
                mapManager.sharedPopup.setContent(mapManager._getPopupContent(mapManager.selectedPointData));
            }
        }
    });

    onChildChanged(ref(db, `${Config.dbRootPath}/events`), (snapshot) => { 
        if (snapshot.val()) {
            const id = snapshot.key;
            const data = snapshot.val();
            uiManager.cacheEvent(id, data);
            mapManager.eventsByTime[data.timestamp] = { id, ...data };
            
            mapManager.renderEventPin(data, (ts) => uiManager.sortedHistoryData.find(d => d.timestamp === ts));

            if (mapManager.selectedPointData && mapManager.selectedPointData.timestamp === data.timestamp) {
                mapManager.sharedPopup.setContent(mapManager._getPopupContent(mapManager.selectedPointData));
            }
        }
    });

    onChildRemoved(ref(db, `${Config.dbRootPath}/events`), (snapshot) => { 
        if (snapshot.val()) {
            const id = snapshot.key;
            const data = snapshot.val();
            const ts = data.timestamp;

            delete uiManager.eventsById[id];
            delete uiManager.eventsByTime[ts];
            delete mapManager.eventsByTime[ts];

            mapManager.removeEventPin(ts);
            
            mapManager.refreshColors(uiManager.getColor.bind(uiManager));

            if (mapManager.selectedPointData && mapManager.selectedPointData.timestamp === ts) {
                mapManager.sharedPopup.setContent(mapManager._getPopupContent(mapManager.selectedPointData));
            }
        }
    });

    const autoCenterBox = document.getElementById('autoCenter');
    if (autoCenterBox) { 
        autoCenterBox.addEventListener('change', (e) => { 
            if (e.target.checked) {
                if (lastGpsData && lastGpsData.lat != null) {
                    mapManager.forceCenter(lastGpsData.lat, lastGpsData.lon);
                } else if (lastValidPosition) {
                    mapManager.forceCenter(lastValidPosition.lat, lastValidPosition.lon);
                }
            }
        }); 
    }
}

main();