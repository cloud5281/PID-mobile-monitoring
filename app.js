import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, onValue, onChildAdded, onChildChanged, onChildRemoved, set, get, update, push, remove } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { Chart, registerables } from 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/+esm';
import zoomPlugin from 'https://cdn.jsdelivr.net/npm/chartjs-plugin-zoom@2.0.1/+esm';

Chart.register(...registerables, zoomPlugin);

const Config = (() => {
    const urlParams = new URLSearchParams(window.location.search);
    const defaultId = "real-time-gps-84c8a";
    const firebaseId = urlParams.get('id') || defaultId; 
    const projectPath = urlParams.get('path') || "test_project";
    const initialRole = urlParams.get('role');
    let userRole = initialRole === 'admin' ? 'admin' : 'guest';

    if (initialRole === 'admin') {
        sessionStorage.setItem('user_role', 'admin');
    } else if (sessionStorage.getItem('user_role') === 'admin') {
        userRole = 'admin';
    }

    let dynamicKey = urlParams.get('key');
    if (dynamicKey) {
        localStorage.setItem('saved_api_key', dynamicKey);
    } else {
        dynamicKey = localStorage.getItem('saved_api_key');
    }
    if (!dynamicKey) {
        dynamicKey = prompt("未偵測到 API Key，請輸入 Firebase API Key:");
        if (dynamicKey) localStorage.setItem('saved_api_key', dynamicKey);
    }

    let cleanUrl = window.location.pathname + '?path=' + projectPath; 
    window.history.replaceState(null, '', cleanUrl);

    if (!firebaseId || !projectPath) {
        alert("網址參數錯誤");
    } 
    return {
        firebaseProjectId: firebaseId,
        apiKey: dynamicKey,
        dbRootPath: projectPath, 
        userRole: userRole,
        gpsIp: "", gpsPort: "", 
        concInstrument: "TSI",
        concSerial: "", concBaudrate: 9600,
        concIp: "", concPort: "",
        concUnit: "",
        timeDelay: 0, 
        dbURL: urlParams.get('db') || null,
        ZOOM_LEVEL: 17, 
        COLORS: { GREEN: '#28a745', YELLOW: '#ffe600', ORANGE: '#fd7e14', RED: '#dd0000' }
    };
})();

class MapManager {
    constructor(initLat = 25.0330, initLon = 121.5654) {
        const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors'
        });

        const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
            attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community'
        });

        this.map = L.map('map', {
            center: [initLat, initLon],
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
        this.allMarkers = [];
        
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
                const hData = getHistoryRecordFn(eventData.timestamp);
                
                // 🔥 確保跳轉的座標以「大頭針原本紀錄的精確座標」為準，避免被 Excel 截斷秒數的歷史點拉走
                const targetData = {
                    lat: eventData.lat,
                    lon: eventData.lon,
                    timestamp: eventData.timestamp,
                    conc: hData ? hData.conc : '?',
                    conc_unit: hData ? hData.conc_unit : ''
                };
                this.focusOnPoint(targetData);
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
        this.allMarkers.forEach((layer) => {
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
        const concStr = (data.conc != null && data.conc >= 0 && data.status !== 'Conc Lost') ? `${data.conc} ${unit}` : `<span style="color:gray;">無訊號</span>`;
        return `
            <div style="text-align: left; line-height: 1.5;">
                <span>⏰ 時間:</span> ${data.timestamp}<br>
                <span>📍 經緯:</span> ${data.lon.toFixed(6)}, ${data.lat.toFixed(6)}<br>
                <span>🧪 濃度:</span> ${concStr}<br>
            </div>`;
    }

    _getPopupContent(data) {
        const unit = data.conc_unit || Config.concUnit || "";
        const concStr = (data.conc != null && data.conc >= 0 && data.status !== 'Conc Lost') ? `${data.conc} ${unit}` : `<span style="color:gray;">無訊號</span>`;
        let html = `
            <div style="text-align: left; line-height: 1.5; min-width: 200px; max-width: 280px;">
                <span>⏰ 時間:</span> ${data.timestamp}<br>
                <span>📍 經緯:</span> ${data.lon.toFixed(6)}, ${data.lat.toFixed(6)}<br>
                <span>🧪 濃度:</span> ${concStr}<br>
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

    requestSort() {
        if (this.sortTimeout) return;
        // 防抖(Debounce)：如果短時間內加入大量點(例如載入歷史資料)，只會在最後執行一次排序，避免網頁卡頓
        this.sortTimeout = setTimeout(() => {
            this.sortPointsByConcentration();
            this.sortTimeout = null;
        }, 100);
    }
    sortPointsByConcentration() {
        const layers = [];
        this.historyLayer.eachLayer(layer => {
            if (layer.concValue !== undefined && this.map.hasLayer(layer)) {
                layers.push(layer);
            }
        });

        // 依照濃度排序：灰點(-1)放最下層，濃度數值越大放越上面
        layers.sort((a, b) => {
            const valA = (a.concValue != null && a.concValue >= 0) ? a.concValue : -1;
            const valB = (b.concValue != null && b.concValue >= 0) ? b.concValue : -1;
            return valA - valB;
        });

        // 依序拉到最上層 (SVG 的特性是越晚 bringToFront 的元素會在最頂部)
        layers.forEach(layer => {
            if (layer.bringToFront) {
                layer.bringToFront();
            }
        });

        // 如果目前使用者有點擊了某個高亮點，確保該點在最最最頂層
        if (this.lastHighlightedLayer && this.lastHighlightedLayer.bringToFront) {
            this.lastHighlightedLayer.bringToFront();
        }
    }

    addHistoryPoint(data, getColorFn) {
        if (data.status === 'GPS Lost' || data.status === 'All Lost' || data.status === 'V') {
            return;
        }

        if (data.lat !== undefined && data.lat !== null && data.lon !== undefined && data.lon !== null) {
            const pos = [data.lat, data.lon];
            this.coordsArray.push(pos);
            this.pathLine.setLatLngs(this.coordsArray);
            
            let color = '#999999';
            if (data.conc !== undefined && data.conc !== null && data.conc >= 0 && data.status !== 'Conc Lost') {
                color = getColorFn(data.conc);
            }

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
            this.allMarkers.push(circle);

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
        this.allMarkers.forEach((layer) => {
            if (layer.timestamp <= cutoffTime) {
                if (!this.historyLayer.hasLayer(layer)) {
                    this.historyLayer.addLayer(layer);
                }
                layer.setStyle({ opacity: 1, fillOpacity: 0.9 });
            } else {
                if (this.historyLayer.hasLayer(layer)) {
                    this.historyLayer.removeLayer(layer);
                }
            }
        });

        // 事件圖釘 (📌) 原本的邏輯已經是移除/新增，維持不變即可
        this.eventPins.forEach((pin, timestamp) => {
            if (timestamp <= cutoffTime) {
                if (!this.map.hasLayer(pin)) pin.addTo(this.map);
            } else {
                if (this.map.hasLayer(pin)) pin.remove();
            }
        });
    }

    refreshColors(getColorFn) {
        this.allMarkers.forEach((layer) => {
            if (layer.concValue !== undefined) {
                if (layer === this.lastHighlightedLayer) return; 
                const hasEvent = !!this.eventsByTime[layer.timestamp];
                const color = (layer.concValue != null && layer.concValue >= 0) ? getColorFn(layer.concValue) : '#999999';
                
                // 強制給定完整的 SVG 屬性，防呆 Leaflet 渲染器
                layer.setStyle({ 
                    fillColor: color,
                    fillOpacity: 0.9,
                    fill: true,
                    stroke: hasEvent,
                    color: hasEvent ? '#000' : 'transparent',
                    weight: hasEvent ? 2 : 0
                });
            }
        });
        this.requestSort();
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
        if (localStorage.getItem('is_switching') === 'true') {
            this.setInterfaceMode('switching', "專案切換中... (約 1 分鐘)", "gray", "offline");
        } else {
            this.setInterfaceMode('offline', "未連接 Controller", "gray", "offline");
        }
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
                gps_ip: document.getElementById('set-gps-ip'),
                gps_port: document.getElementById('set-gps-port'),
                conc_instrument: document.getElementById('set-conc-instrument'),
                conc_serial: document.getElementById('set-conc-serial'),
                conc_baudrate: document.getElementById('set-conc-baudrate'), 
                conc_ip: document.getElementById('set-conc-ip'),
                conc_port: document.getElementById('set-conc-port'),
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
            btnCloseLightbox: document.getElementById('btn-close-lightbox'),

            // 🔥 新增風標相關的 DOM 元素
            windPanel: document.getElementById('wind-compass-panel'),
            windIconBtn: document.getElementById('wind-icon-btn'),
            windArrow: document.getElementById('wind-arrow'),
            windObsTime: document.getElementById('wind-obs-time'),
            windStationSpeed: document.getElementById('wind-station-speed'), 
            windUpdateTime: document.getElementById('wind-update-time'),
            windToggleBtn: document.getElementById('wind-toggle-btn')
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

        if (this.els.radiusSlider && this.els.radiusValue) {
            this.els.radiusSlider.value = this.mapManager.pointRadius;
            this.els.radiusValue.innerText = this.mapManager.pointRadius;
        }

        if (window.innerWidth <= 768 && this.els.mainPanel) {
            this.els.mainPanel.classList.add('collapsed');
        }
    }

    // 根據下拉選單(instrument)切換顯示/隱藏
    toggleInstrumentFields() {
        if (!this.els.backendInputs.conc_instrument) return;
        const inst = this.els.backendInputs.conc_instrument.value;
        const pidFields = document.querySelectorAll('.pid-field');
        const tsiFields = document.querySelectorAll('.tsi-field');
        
        if (inst === 'PID') {
            pidFields.forEach(el => el.classList.remove('hidden'));
            tsiFields.forEach(el => el.classList.add('hidden'));
        } else {
            pidFields.forEach(el => el.classList.add('hidden'));
            tsiFields.forEach(el => el.classList.remove('hidden'));
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
        this.mapManager.requestSort();
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

        this.updateWindCompass(record);

        if (this.chart) {
            const slicedData = this.sortedHistoryData.slice(0, index + 1);
            const values = slicedData.map(d => (d.conc !== null && d.conc >= 0 && d.status !== 'Conc Lost') ? d.conc : null);
            
            let currentMax = 0;
            let currentMaxUnit = Config.concUnit || "";
            for (let i = 0; i < slicedData.length; i++) {
                let d = slicedData[i];
                if (d.conc !== null && d.conc >= 0 && d.status !== 'Conc Lost') {
                    if (d.conc > currentMax) {
                        currentMax = d.conc;
                        if (d.conc_unit) currentMaxUnit = d.conc_unit; // 記錄最大值當下的單位
                    } else if (currentMax === 0 && d.conc_unit) {
                        currentMaxUnit = d.conc_unit; // 若最大值還是0，先隨便備份一個有效單位
                    }
                }
            }

            if (this.els.concMax) {
                this.els.concMax.innerText = `Max: ${currentMax} ${currentMaxUnit}`;
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
        
        const rawSorted = Object.values(historyData)
            .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        this.sortedHistoryData = rawSorted;

        const allValues = this.sortedHistoryData.map(d => (d.conc !== null && d.conc >= 0 && d.status !== 'Conc Lost') ? d.conc : null);
        
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
        let globalMaxUnit = Config.concUnit || ""; 
        for (let i = 0; i < this.sortedHistoryData.length; i++) {
            let d = this.sortedHistoryData[i];
            if (d.conc !== null && d.conc >= 0 && d.status !== 'Conc Lost') {
                if (d.conc > globalMax) {
                    globalMax = d.conc;
                    if (d.conc_unit) globalMaxUnit = d.conc_unit; 
                } else if (globalMax === 0 && d.conc_unit) {
                    globalMaxUnit = d.conc_unit; 
                }
            }
        }
        
        this.chart.options.scales.y.suggestedMax = (globalMax > 0) ? globalMax * 1.05 : 10;
        delete this.chart.options.scales.y.max;
        this.chart.options.scales.y.min = 0;

        if (this.els.concMax) {
            if (globalMax > 0) {
                this.els.concMax.innerText = `Max: ${globalMax} ${globalMaxUnit}`;
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
                const lastRecord = this.sortedHistoryData[this.sortedHistoryData.length - 1];
                this.mapManager.updateVisibleHistory(lastRecord.timestamp);

                if (lastRecord.lat != null && lastRecord.lon != null) {
                    // 覆寫小人座標
                    this.mapManager.updateCurrentPosition(lastRecord.lat, lastRecord.lon, this.els.autoCenter.checked);
                    // 同步覆寫右側的狀態面板，確保面板能正確顯示「Conc 訊號中斷」
                }
                
                if (this.currentMode === 'recording') {
                    this.updateRealtimeData(lastRecord);
                }

                this.updateWindCompass(lastRecord);
            }
        }
    }

    // 🔥 負責處理風標邏輯的方法
    updateWindCompass(data) {
        if (!data || data.wind_dir === undefined || data.wind_speed === undefined) {
            this.els.windPanel.classList.add('hidden');
            return;
        }

        this.els.windPanel.classList.remove('hidden');

        const stationName = data.station_name || "未知測站";
        const windSpeed = data.wind_speed !== undefined ? data.wind_speed : "--";
        
        if (this.els.windStationSpeed) {
            this.els.windStationSpeed.innerText = `測站: ${stationName}； 風速: ${windSpeed} m/s`;
        }
        
        // 【觀測時間】：對應 WindReader 抓到的氣象站觀測時間 (data.wind_time)
        if (this.els.windObsTime) {
            // 如果後端有傳 ISO 格式，可視需求保留全貌或自訂格式
            this.els.windObsTime.innerText = `觀測時間：${data.wind_time || "--:--:--"}`;
        }

        // 【更新於】：對應戳 API 的當下時間（即系統處理這筆 GPS 的 timestamp）
        let updateTime = "--:--";
        if (data.timestamp) {
            const timeMatch = data.timestamp.match(/\d{2}:\d{2}/);
            if (timeMatch) updateTime = timeMatch[0];
        }
        if (this.els.windUpdateTime) {
            this.els.windUpdateTime.innerText = `更新於${updateTime}`;
        }

        // 更新風標箭頭旋轉角度
        const rotationDegree = data.wind_dir + 180;
        this.els.windArrow.style.transform = `rotate(${rotationDegree}deg)`;
    }

    syncConfigFromBackend(data) {
        if (!data) return;
        Config.gpsIp = data.gps_ip || ""; 
        Config.gpsPort = data.gps_port || ""; 

        Config.concInstrument = data.conc_instrument || "TSI"; // 🔥 接收儀器名稱
        Config.concSerial = data.conc_serial || "";
        Config.concBaudrate = data.conc_baudrate || 9600;
        Config.concIp = data.conc_ip || "";
        Config.concPort = data.conc_port || "";
        Config.concUnit = data.conc_unit || "";

        Config.timeDelay = data.time_delay !== undefined ? data.time_delay : 0; 
        
        if (!this.els.modal.classList.contains('hidden')) this.fillSettingsInputs();
        
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
            if (Config.userRole === 'admin') {
                this.saveThresholdSettings(true); 
            }
            return; 
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
        this.els.backendInputs.gps_ip.value = Config.gpsIp; 
        this.els.backendInputs.gps_port.value = Config.gpsPort;

        if (this.els.backendInputs.conc_instrument) {
            this.els.backendInputs.conc_instrument.value = Config.concInstrument; 
            this.toggleInstrumentFields(); // 確保每次打開時，顯示的是正確儀器的欄位
        }

        if (this.els.backendInputs.conc_baudrate) this.els.backendInputs.conc_baudrate.value = Config.concBaudrate;
        if (this.els.backendInputs.conc_ip) this.els.backendInputs.conc_ip.value = Config.concIp;
        if (this.els.backendInputs.conc_port) this.els.backendInputs.conc_port.value = Config.concPort;
        if (this.els.backendInputs.time_delay) this.els.backendInputs.time_delay.value = Config.timeDelay;
        
        if (this.els.backendInputs.conc_serial) {
            let exists = false;
            for (let i = 0; i < this.els.backendInputs.conc_serial.options.length; i++) {
                if (this.els.backendInputs.conc_serial.options[i].value === Config.concSerial) {
                    exists = true; 
                    break;
                }
            }
            if (exists) {
                this.els.backendInputs.conc_serial.value = Config.concSerial;
            }
            else {
                this.els.backendInputs.conc_serial.selectedIndex = 0;
            }
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
        if (this.els.backendInputs.conc_instrument) {
            this.els.backendInputs.conc_instrument.addEventListener('change', () => this.toggleInstrumentFields());
        }
        
        this.els.btnSaveBackend.addEventListener('click', () => {
            const updateData = {}; 

            const p = this.els.backendInputs.project.value.trim(); 

            const gi = this.els.backendInputs.gps_ip.value.trim(); 
            const gp = this.els.backendInputs.gps_port.value.trim(); 
            
            const inst = this.els.backendInputs.conc_instrument ? this.els.backendInputs.conc_instrument.value : "TSI"; 
            updateData.conc_instrument = inst;
            const cs = this.els.backendInputs.conc_serial ? this.els.backendInputs.conc_serial.value : "";
            const cb = this.els.backendInputs.conc_baudrate ? this.els.backendInputs.conc_baudrate.value : "";
            const ci = this.els.backendInputs.conc_ip ? this.els.backendInputs.conc_ip.value.trim() : "";
            const cp = this.els.backendInputs.conc_port ? this.els.backendInputs.conc_port.value : "";
            const td = this.els.backendInputs.time_delay ? this.els.backendInputs.time_delay.value.trim() : ""; 
            
            if (p) updateData.project_name = p;

            if (gi) updateData.gps_ip = gi; 
            if (gp) updateData.gps_port = gp; 
            
            if (inst) updateData.conc_instrument = inst;
            if (cs) updateData.conc_serial = cs;
            if (cb) updateData.conc_baudrate = cb;
            if (ci) updateData.conc_ip = ci; 
            if (cp) updateData.conc_port = cp;
            
            if (td !== "") updateData.time_delay = parseFloat(td); 
            
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
                    if (Config.userRole === 'admin') {
                        url.searchParams.set('role', 'admin');
                    }
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
            input.addEventListener('keydown', (e) => { 
                if (e.key === 'Enter') { 
                    input.blur(); 
                } 
            });
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
    
        if (this.els.windToggleBtn && this.els.windPanel) {
            this.els.windToggleBtn.addEventListener('click', () => {
                this.els.windPanel.classList.toggle('is-collapsed');
            });
        }
        if (this.els.windIconBtn && this.els.windPanel) {
            this.els.windIconBtn.addEventListener('click', () => {
                this.els.windPanel.classList.toggle('is-collapsed');
            });
        }
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
        if (!data || Object.keys(data).length === 0) {
            this.els.coords.innerText = "-";
            this.els.coords.style.color = 'black';
            this.els.conc.innerText = "-";
            this.els.conc.style.color = 'black';
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
        this.currentMode = mode;
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
                this.mapManager.requestSort();
                break;

            case 'offline':
                this.els.controlBar.style.display = ''; 
                this.els.btnUpload.classList.remove('hidden'); 
                this.els.btnDownload.classList.remove('hidden'); 
                this.els.btnOpenSettings.classList.remove('hidden');
                
                if (this.els.playbackPanel) this.els.playbackPanel.style.display = 'flex';
                this.mapManager.requestSort();
                break;

            case 'switching':
                this.els.controlBar.style.display = 'none';
                this.els.btnOpenSettings.classList.add('hidden');
                this.els.btnUpload.classList.add('hidden');
                this.els.btnDownload.classList.add('hidden');
                thresholdInputs.forEach(input => input.disabled = true);
                break;
        }

        if (Config.userRole !== 'admin') {
            // 強制隱藏會影響後端運作的按鈕
            this.els.btnStart.classList.add('hidden');
            this.els.btnOpenSettings.classList.add('hidden');
            if (mode === 'offline') {
                this.els.btnUpload.classList.remove('hidden');
                this.els.btnDownload.classList.remove('hidden');
                this.els.controlBar.style.display = '';
            } else {
                this.els.btnUpload.classList.add('hidden');
                this.els.btnDownload.classList.add('hidden');
                this.els.controlBar.style.display = 'none';
            }
            
            if (this.els.thresholdTitle) {
                const unitText = Config.concUnit ? ` (${Config.concUnit})` : "";
                this.els.thresholdTitle.innerHTML = `濃度閾值設定${unitText} <span style="font-size: 11px; color: #007bff; font-weight: normal;">(本地端預覽)</span>`;
            }
        }
    }

    triggerUploadProcess() { const input = document.createElement('input'); input.type = 'file'; input.accept = '.csv'; input.style.display = 'none'; input.onchange = (e) => { const file = e.target.files[0]; if (file) this.parseAndUploadCSV(file); }; document.body.appendChild(input); input.click(); document.body.removeChild(input); }
    parseAndUploadCSV(file) { 
        const btn = this.els.btnUpload; 
        const originalText = btn.innerText; 
        btn.disabled = true; btn.innerText = "上傳中..."; 
        let projectName = file.name.replace(/\.csv$/i, "").trim(); 
        if (!projectName) { alert("檔名無效"); btn.disabled = false; btn.innerText = originalText; return; } 
        
        const reader = new FileReader(); 
        reader.onload = (e) => { 
            try { 
                const buffer = e.target.result; 
                let text = new TextDecoder("utf-8").decode(buffer);
                // 如果發現 UTF-8 解碼失敗的菱形替換字元，就切換成台灣 Excel 預設的 Big5 解碼
                if (text.includes('')) {
                    text = new TextDecoder("big5").decode(buffer);
                } 
                
                const parseCSV = (str) => {
                    let firstLine = str.split('\n')[0];
                    let delimiter = ',';
                    if (firstLine.includes(';')) delimiter = ';';
                    else if (firstLine.includes('\t')) delimiter = '\t';

                    const out = [];
                    let row = [], col = '', quote = false;
                    for (let i = 0; i < str.length; i++) {
                        let c = str[i], nc = str[i+1];
                        if (c === '"' && quote && nc === '"') {
                            col += '"'; i++; // 處理雙引號跳脫
                        } else if (c === '"') {
                            quote = !quote;  // 進入或離開字串模式
                        } else if (c === delimiter && !quote) {
                            row.push(col.trim()); col = '';
                        } else if ((c === '\n' || c === '\r') && !quote) {
                            if (c === '\r' && nc === '\n') i++; // 處理 Windows 換行
                            row.push(col.trim());
                            if (row.length > 1 || row[0] !== '') out.push(row);
                            row = []; col = '';
                        } else {
                            col += c;
                        }
                    }
                    if (col !== '' || row.length > 0) {
                        row.push(col.trim());
                        if (row.length > 1 || row[0] !== '') out.push(row);
                    }
                    return out;
                };

                const rows = parseCSV(text);
                if (rows.length < 2) throw new Error("CSV 為空或格式錯誤"); 
                
                const uploadData = {}; 
                const uploadEvents = {}; 
                let count = 0; 
                let lastRecord = null; 

                for (let i = 1; i < rows.length; i++) { 
                    let cols = rows[i]; 

                    // 救援模式：自動修復舊版無逗號的資料
                    if (cols.length < 4 && cols[0] && cols[0].split(' ').length >= 6) {
                        const parts = cols[0].trim().replace(/\s+/g, ' ').split(' ');
                        if (parts[0].includes('/') && parts[1].includes(':')) {
                            cols = [
                                `${parts[0]} ${parts[1]}`, 
                                parts[2], parts[3], parts[4], parts[5], 
                                parts.slice(6).join(' '), 
                                "", "" 
                            ];
                        }
                    }

                    const timestampStr = cols[0] ? cols[0] : "";
                    if (!timestampStr) continue; 

                    let parsedLat = parseFloat(cols[1]);
                    let parsedLon = parseFloat(cols[2]);
                    let parsedConc = parseFloat(cols[3]);
                    const record = { 
                        timestamp: timestampStr, 
                        lat: isNaN(parsedLat) ? null : parsedLat, 
                        lon: isNaN(parsedLon) ? null : parsedLon, 
                        conc: isNaN(parsedConc) ? null : parsedConc,
                        conc_unit: cols[4] ? cols[4] : "", 
                        status: cols[5] ? cols[5] : "" 
                    }; 
                    
                    if (record.timestamp) { 
                        const key = `record_${Date.now()}_${i}`; 
                        uploadData[key] = record; 
                        if (record.lat !== null && record.lon !== null) {
                            lastRecord = record; 
                        } 
                        count++; 
                    } 

                    const note = cols[6] ? cols[6] : "";
                    let imagesStr = cols[7] ? cols[7] : "";
                    
                    if (imagesStr === "[]") imagesStr = "";
                    
                    // 還原註記與圖片
                    if (note !== "" || imagesStr !== "") {
                        let parsedImages = [];
                        if (imagesStr !== "") {
                            try { parsedImages = JSON.parse(imagesStr); } 
                            catch(err) { /* 如果字串有誤就直接留空陣列 */ }
                        }
                        const eventKey = `event_${Date.now()}_${i}`;
                        uploadEvents[eventKey] = {
                            timestamp: timestampStr,
                            lat: record.lat,
                            lon: record.lon,
                            note: note,
                            images: parsedImages
                        };
                    }
                } 
                if (count === 0) throw new Error("無有效數據"); 

                const updates = {}; 
                updates[`${projectName}/history`] = uploadData; 
                
                if (Object.keys(uploadEvents).length > 0) {
                    updates[`${projectName}/events`] = uploadEvents;
                } else {
                    updates[`${projectName}/events`] = null; 
                }
                
                if (lastRecord) updates[`${projectName}/latest`] = lastRecord; 

                update(ref(this.db), updates).then(() => { 
                    const isDiff = (projectName !== Config.dbRootPath); 
                    if (isDiff) { 
                        alert(`上傳成功，切換至: ${projectName}`); 
                        if (Config.userRole === 'admin') {
                            set(ref(this.db, `${Config.dbRootPath}/control/config_update`), { project_name: projectName }); 
                        }
                        const url = new URL(window.location.href); 
                        url.searchParams.set('path', projectName); 
                        if (Config.userRole === 'admin') {
                            url.searchParams.set('role', 'admin');
                        }
                        localStorage.setItem('should_fit_bounds', 'true'); 
                        window.location.href = url.toString(); 
                    } 
                    else { 
                        localStorage.setItem('should_fit_bounds', 'true'); 
                        alert("上傳成功"); 
                        location.reload(); 
                    } 
                }).catch(err => { 
                    alert("上傳失敗: " + err.message); 
                    btn.disabled = false; 
                    btn.innerText = originalText;
                }); 
            } catch (err) { 
                alert("解析失敗: " + err.message); 
                btn.disabled = false; 
                btn.innerText = originalText; 
            } 
        }; 
        reader.readAsArrayBuffer(file); 
    }

    async downloadHistoryAsCSV() { 
        const btn = this.els.btnDownload;
        const originalText = btn.innerText; 
        btn.disabled = true; 
        btn.innerText = "下載中..."; 
        try { 
            // 同時抓取歷史軌跡與註記事件
            const [historySnap, eventsSnap] = await Promise.all([
                get(ref(this.db, `${Config.dbRootPath}/history`)),
                get(ref(this.db, `${Config.dbRootPath}/events`))
            ]);

            if (!historySnap.exists()) { alert("無歷史資料"); return; } 
            
            const data = historySnap.val(); 
            const eventsData = eventsSnap.exists() ? eventsSnap.val() : {};

            // 建立事件字典，用時間戳記來對應
            const eventsMap = {};
            Object.values(eventsData).forEach(ev => {
                eventsMap[ev.timestamp] = ev;
            });

            // 新增 note 與 images 欄位
            let csvContent = "\uFEFFtimestamp,lat,lon,conc,conc_unit,status,note,images\n"; 
            
            const sortedData = Object.values(data).sort((a, b) => {
                const timeA = a.timestamp || "";
                const timeB = b.timestamp || "";
                return timeA.localeCompare(timeB);
            });

            // CSV 逸出處理函式（處理逗號與換行）
            const escapeCSV = (str) => {
                if (!str) return "";
                return `"${String(str).replace(/"/g, '""')}"`;
            };

            sortedData.forEach(row => { 
                const t = row.timestamp || ""; 
                const lat = (row.lat !== undefined && row.lat !== null) ? row.lat : ""; 
                const lon = (row.lon !== undefined && row.lon !== null) ? row.lon : ""; 
                const conc = (row.conc !== undefined && row.conc !== null) ? row.conc : "";
                const unit = row.conc_unit || Config.concUnit; 
                const st = row.status || ""; 
                
                // 抓取對應的註記與圖片
                const ev = eventsMap[t];
                const note = ev && ev.note ? ev.note : "";
                // 將圖片陣列轉為 JSON 字串方便儲存
                const images = ev && ev.images ? JSON.stringify(ev.images) : "";

                csvContent += `${t},${lat},${lon},${conc},${unit},${st},${escapeCSV(note)},${escapeCSV(images)}\n`; 
            }); 
            
            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' }); 
            const url = URL.createObjectURL(blob); 
            const link = document.createElement("a"); 
            link.href = url; link.download = `${Config.dbRootPath}.csv`; 
            link.click(); 
            URL.revokeObjectURL(url); 
        } catch (error) { 
            console.error(error); 
            alert("下載失敗"); 
        } finally { 
            btn.disabled = false; 
            btn.innerText = originalText; 
        } 
    }

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

        this.thresholds = { a: valA, b: valB, c: valC };
        this.updateThresholdDisplay();
        this.mapManager.refreshColors(this.getColor.bind(this));
        if (this.chart) this.chart.update('none');

        if (Config.userRole === 'admin') {
            set(ref(this.db, `${Config.dbRootPath}/settings/thresholds`), { a: valA, b: valB, c: valC })
                .then(() => {
                    if (!isSilent) { msgBox.innerText = "已同步至雲端"; msgBox.style.color = "green"; setTimeout(() => msgBox.innerText = "", 2000); }
                })
                .catch(err => {
                    if (!isSilent) { msgBox.innerText = "雲端儲存失敗"; msgBox.style.color = "red"; }
                });
        } else {
            // Guest 視角，只提示本地畫面更新成功
            if (!isSilent) { msgBox.innerText = "本地畫面已更新"; msgBox.style.color = "#007bff"; setTimeout(() => msgBox.innerText = "", 2000); }
        }
    }
}

async function main() {
    const firebaseConfig = { apiKey: Config.apiKey, authDomain: `${Config.firebaseProjectId}.firebaseapp.com`, databaseURL: Config.dbURL || `https://${Config.firebaseProjectId}-default-rtdb.asia-southeast1.firebasedatabase.app`, projectId: Config.firebaseProjectId };
    const app = initializeApp(firebaseConfig);
    const db = getDatabase(app);
    let initLat = 25.0330;
    let initLon = 121.5654;
    try {
        const snap = await get(ref(db, `${Config.dbRootPath}/latest`));
        if (snap.exists() && snap.val().lat != null && snap.val().lon != null) {
            initLat = snap.val().lat;
            initLon = snap.val().lon;
        }
    } catch (e) {
        console.warn("無法取得初始座標", e);
    }
    
    const mapManager = new MapManager(initLat, initLon);
    const uiManager = new UIManager(mapManager, db);
    let backendState = 'offline';
    let lastGpsData = null;
    let lastValidPosition = null; 
    let hasInitialCentered = false; 

    let lastHeartbeatReceivedTime = Date.now();
    let isHeartbeatLost = true;  // 預設為 true：一開始不信任連線，直到驗證 heartbeat
    let isInitialLoad = true;
    let cachedStatusData = null; // 用來暫存 firebase 傳來的狀態

    const applyStatus = (data) => {
        if (!data || data.state === 'offline') {
            uiManager.setInterfaceMode('offline', "未連接 Controller", "gray", "offline");
            uiManager.updateRealtimeData({}); 
            return;
        }
        backendState = data.state;
        const msg = data.message || "未知狀態";
        switch (data.state) {
            case 'active': uiManager.setInterfaceMode('recording', msg, '#28a745', 'active'); break;
            case 'gps_lost':
            case 'conc_lost':
            case 'all_lost':
            case 'connecting': uiManager.setInterfaceMode('recording', msg, '#ebb400', 'connecting'); break;
            case 'timeout': uiManager.setInterfaceMode('idle', msg, '#dc3545', 'timeout'); break;
            case 'stopped': 
                uiManager.setInterfaceMode('idle', msg, 'gray', 'stopped');
                uiManager.updateRealtimeData({});
                break;
            case 'switching': uiManager.setInterfaceMode('switching', msg, 'gray', 'offline'); break;
            default: uiManager.setInterfaceMode('offline', msg, 'gray', 'offline'); break;
        }
    };

    onValue(ref(db, `${Config.dbRootPath}/heartbeat`), (snapshot) => {
        if (snapshot.exists()) {
            const backendTimestamp = snapshot.val();
            const now = Date.now();
            
            if (isInitialLoad) {
                isInitialLoad = false;
                // 初始檢查：如果 Firebase 上的心跳時間已經超過 30 秒，判定為殭屍狀態
                // (給予 30 秒寬容值是為了吸收前後端電腦的 NTP 時鐘誤差)
                if (now - backendTimestamp > 60000) {
                    // console.warn("偵測到前次未正常關閉的殘留狀態，判定為離線。");
                    isHeartbeatLost = true;
                    backendState = 'offline';
                    if (localStorage.getItem('is_switching') === 'true') {
                        uiManager.setInterfaceMode('switching', "專案切換中... (約 1 分鐘)", "gray", "offline");
                    } else {
                        uiManager.setInterfaceMode('offline', "未連接 Controller", "gray", "offline");
                    }
                    return; 
                }
            }

            // 正常的更新邏輯：記錄前端收到訊號的當下時間
            lastHeartbeatReceivedTime = now;
            
            if (isHeartbeatLost) {
                isHeartbeatLost = false;
                // console.log("Heartbeat 驗證成功，套用最新狀態");
                // 既然確認存活，就把剛才可能被攔截的真實狀態套用上去
                if (cachedStatusData) applyStatus(cachedStatusData);
            }
        }
    });
    // 2. 設置看門狗定期檢查心跳是否逾時
    setInterval(() => {
        const now = Date.now();
        const diff = now - lastHeartbeatReceivedTime;

        // 若超過 30 秒沒收到心跳，且當前狀態不是 offline 或是 stopped
        // 判定為「非正常關閉 (直接關閉 IDE 或斷線)」
        if (diff > 30000 && !isHeartbeatLost && backendState !== 'offline') {
            isHeartbeatLost = true;
            backendState = 'offline';
            // 強制呼叫 uiManager 更新 UI，呈現斷線視覺
            uiManager.setInterfaceMode('offline', "Controller 連線逾時", "gray", "offline");
            uiManager.updateRealtimeData({}); 
        }
    }, 5000); 

    onValue(ref(db, `${Config.dbRootPath}/status/available_ports`), (snapshot) => {
        const ports = snapshot.val() || [];
        const selectEl = document.getElementById('set-conc-serial');
        if (selectEl) {
            const currentVal = selectEl.value;
            selectEl.innerHTML = '';

            if (ports.length > 0) {
                ports.forEach(p => {
                    const opt = document.createElement('option');
                    opt.value = p;
                    opt.innerText = (p === Config.concSerial) ? `${p} (目前設定)` : p;
                    selectEl.appendChild(opt);
                });
                
                if (ports.includes(currentVal)) {
                    selectEl.value = currentVal; // 維持使用者剛才選的
                } else if (ports.includes(Config.concSerial)) {
                    selectEl.value = Config.concSerial; // 顯示 config 裡面儲存的
                } else {
                    selectEl.selectedIndex = 0; // 若都沒中，預設選單純的第一個設備
                }
            } else {
                const opt = document.createElement('option');
                opt.value = "";
                opt.innerText = "未偵測到設備";
                selectEl.appendChild(opt);
                selectEl.value = "";
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
        cachedStatusData = data;
        if (localStorage.getItem('is_switching') === 'true') {
            if (data && data.state === 'stopped') {
                // 代表後端已經初始化完畢，正式切換完成！此時才移除旗標並解除鎖定
                localStorage.removeItem('is_switching');
            } else {
                // 否則強制保持切換中的提示，不讓「未連接 Controller」閃爍
                uiManager.setInterfaceMode('switching', "專案切換中... (約 1 分鐘)", "gray", "offline");
                uiManager.updateRealtimeData({});
                return;
            }
        }
        
        if (isHeartbeatLost) {
            uiManager.setInterfaceMode('offline', "未連接 Controller", "gray", "offline");
            uiManager.updateRealtimeData({});
            return;
        }

        applyStatus(data);
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
                // 🔥 在 Live 模式下更新最新風標
                uiManager.updateWindCompass(data);
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