import os
os.environ["OPENCV_LOG_LEVEL"] = "FATAL"

import logging
import threading
import time
import firebase_admin
import webbrowser
import json
import numpy as np
import serial.tools.list_ports
import cv2
import subprocess

from pygrabber.dshow_graph import FilterGraph
from firebase_admin import credentials, db, exceptions
from Config import Config
from Process import RunProcedures

class SystemController:
    def __init__(self, config_file="config.json"):
        self.config_file = config_file
        self.logger = self._setup_logger()
        self.process = None
        self.process_thread = None
        self.preview_camera = None
        
        self.cmd_listener = None
        self.config_listener = None
        self.threshold_listener = None

        try:
            self.cfg = Config(self.config_file)
        except Exception as e:
            self.logger.error(f"❌ 設定檔讀取失敗: {e}")
            raise

        self._init_firebase()
        self.heartbeat_thread = threading.Thread(target=self._heartbeat_loop, daemon=True)
        self.heartbeat_thread.start()

    def _heartbeat_loop(self):
        """每 5 秒發送一次到 Firebase"""
        while True:
            try:
                current_time = int(time.time() * 1000)
                # 建議放在獨立的 /heartbeat 節點，避免頻繁觸發 /status 節點的 UI 更新
                db.reference(f'{self.cfg.PROJECT_NAME}/heartbeat').set(current_time)
            except Exception as e:
                self.logger.warning(f"Heartbeat 發送失敗: {e}")
            time.sleep(5)

    def _setup_logger(self):
        log_filename = "execution.log" 
        handlers = [
            logging.StreamHandler(),
            logging.FileHandler(log_filename, encoding='utf-8', mode='w') 
        ]
        logging.basicConfig(
            level=logging.INFO,
            format='[%(asctime)s] %(message)s',
            datefmt='%y/%m/%d %H:%M:%S',
            handlers=handlers,
            force=True  
        )
        return logging.getLogger("Controller")

    def _init_firebase(self):
        try:
            if not firebase_admin._apps:
                cred = credentials.Certificate(self.cfg.FIREBASE_KEY)
                firebase_admin.initialize_app(cred, {'databaseURL': self.cfg.DB_URL})
            self.logger.info("📡 Controller 已連線至 Firebase")
        except Exception as e:
            self.logger.error(f"❌ Firebase 連線失敗: {e}")

    def _start_camera_preview(self, index):
        self._stop_camera_preview()
        self.preview_running = True
        self.preview_thread = threading.Thread(target=self._preview_loop, args=(index,), daemon=True)
        self.preview_thread.start()

    def _stop_camera_preview(self):
        self.preview_running = False
        if hasattr(self, 'preview_thread') and self.preview_thread:
            self.preview_thread.join(timeout=1.0)
            self.preview_thread = None

    def _preview_loop(self, index):
        cap = cv2.VideoCapture(index, cv2.CAP_DSHOW)
        if not cap.isOpened():
            self.logger.error(f"預覽失敗：無法開啟鏡頭 {index}")
            self.preview_running = False
            return
        win_name = "Preview Mode"
        
        # 使用 WINDOW_NORMAL，保留所有預設的 Windows 控制項（包含縮放與右上角的叉叉）
        cv2.namedWindow(win_name, cv2.WINDOW_NORMAL)

        while self.preview_running:
            # 偵測是否被使用者按右上角的「X」關閉
            try:
                # WND_PROP_VISIBLE 在視窗開啟時為 1，被手動關閉時會變為 0 或小於 0
                if cv2.getWindowProperty(win_name, cv2.WND_PROP_VISIBLE) < 1:
                    self.preview_running = False
                    break
            except Exception:
                self.preview_running = False
                break

            ret, frame = cap.read()
            if not ret:
                time.sleep(0.1)
                continue

            cv2.imshow(win_name, frame)
            cv2.waitKey(30)

        cap.release()
        try:
            cv2.destroyWindow(win_name)
            cv2.waitKey(1)
        except Exception:
            pass

    def _push_current_config_to_firebase(self):
        data = {
                "db_id": self.cfg.DB_ID,
                "project_name": self.cfg.PROJECT_NAME,
                "gps_ip": self.cfg.GPS_IP,
                "gps_port": self.cfg.GPS_PORT,
                "conc_instrument": self.cfg.CONC_INSTRUMENT,
                "conc_serial": self.cfg.CONC_SERIAL_PORT,
                "conc_baudrate": self.cfg.CONC_BAUDRATE,
                "conc_ip": self.cfg.CONC_IP,
                "conc_port": self.cfg.CONC_PORT,
                "conc_unit": self.cfg.CONC_UNIT,
                "time_delay": self.cfg.TIME_DELAY,
                "camera_enabled": self.cfg.CAMERA_ENABLED,
                "camera_index": self.cfg.CAMERA_INDEX 
        }
            
        try:
            db.reference(f'{self.cfg.PROJECT_NAME}/settings/current_config').set(data)
            self.logger.info(f"📤 已同步設定至專案: {self.cfg.PROJECT_NAME}")
        except Exception as e:
            self.logger.warning(f"同步參數失敗: {e}")

    def _setup_listeners(self):
        self._cleanup_listeners()
        self.logger.info(f"👂 準備監聽專案路徑: {self.cfg.PROJECT_NAME}")

        max_retries = 3
        retry_delay = 2

        for attempt in range(max_retries):
            try:
                cmd_ref = db.reference(f'{self.cfg.PROJECT_NAME}/control/command')
                cmd_ref.set("") 
                self.cmd_listener = cmd_ref.listen(self._command_handler)

                config_ref = db.reference(f'{self.cfg.PROJECT_NAME}/control/config_update')
                config_ref.delete()
                self.config_listener = config_ref.listen(self._handle_config_update)

                threshold_ref = db.reference(f'{self.cfg.PROJECT_NAME}/settings/thresholds')
                self.threshold_listener = threshold_ref.listen(self._handle_threshold_update)

                self.logger.info("✅ 監聽器啟動成功")
                return 

            except Exception as e:
                self.logger.warning(f"⚠️ 監聽器啟動失敗 (嘗試 {attempt + 1}/{max_retries}): {e}")
                self._cleanup_listeners() 
                if attempt < max_retries - 1:
                    time.sleep(retry_delay) 
                else:
                    self.logger.error("❌ 監聽器啟動失敗，已達最大重試次數。請檢查網路或重啟程式。")

    def _cleanup_listeners(self):
        """
        🔥 修復：將關閉 Listener 的動作丟入背景執行緒，避免因 Thread 鎖死導致卡頓 30 秒
        """
        cmd_to_close = self.cmd_listener
        conf_to_close = self.config_listener
        thr_to_close = self.threshold_listener
        
        self.cmd_listener = None
        self.config_listener = None
        self.threshold_listener = None
        
        def close_them():
            try:
                if cmd_to_close: cmd_to_close.close()
                if conf_to_close: conf_to_close.close()
                if thr_to_close: thr_to_close.close()
            except Exception:
                pass
                
        threading.Thread(target=close_them, daemon=True).start()

    def _handle_config_update(self, event):
        if event.data is None or event.data == "": return
        new_settings = event.data
        self.logger.info(f"⚙️ 收到參數更新請求: {new_settings}")
        
        threading.Thread(target=self._perform_project_switch, args=(new_settings,)).start()

    def _handle_threshold_update(self, event):
        if event.data is None: return
        try:
            new_c = None
            # Firebase 回傳的結構：可能是字典 {'a':50, 'b':100, 'c':150} 或者是單一欄位更新 path='/c'
            if isinstance(event.data, dict) and 'c' in event.data:
                new_c = float(event.data['c'])
            elif event.path == '/c':
                new_c = float(event.data)
                
            if new_c is not None:
                self.cfg.CAMERA_THRESHOLD = new_c
                self.logger.info(f"📸 收到閾值更新，相機觸發拍照濃度變更為：{new_c}")
                
                # 如果主程式正在執行，且相機模組存在，直接覆寫觸發條件
                if self.process and hasattr(self.process, 'camera') and self.process.camera:
                    self.process.camera.threshold = new_c
        except Exception as e:
            self.logger.warning(f"⚠️ 解析閾值更新失敗：{e}")

    def _perform_project_switch(self, new_settings):
        old_project_name = self.cfg.PROJECT_NAME
        new_project_name = new_settings.get('project_name', old_project_name)

        try:
            if old_project_name != new_project_name:
                self.logger.info(f"👋 正在將舊專案 ({old_project_name}) 標記為離線...")
                db.reference(f'{old_project_name}/status').set({
                    'state': 'offline',
                    'message': f'後端已切換至: {new_project_name}'
                })
                
                self.logger.info(f"🔜 預先初始化新專案 ({new_project_name}) 狀態...")
                db.reference(f'{new_project_name}/status').set({
                    'state': 'switching', 
                    'message': '專案切換中... (約 1 分鐘)'
                })
            else:
                self.logger.info(f"📝 已更新參數")

            config_absolute_path = self.cfg.BASE_DIR / self.config_file

            with open(config_absolute_path, 'r', encoding='utf-8') as f:
                config_data = json.load(f)

            if 'project_name' in new_settings:
                config_data['settings']['project_name'] = new_settings['project_name']
            if 'gps_ip' in new_settings:
                config_data['gps']['wifi_ip'] = new_settings['gps_ip']
            if 'gps_port' in new_settings:
                config_data['gps']['port'] = int(new_settings['gps_port'])
            if 'conc_instrument' in new_settings:
                config_data['conc']['instrument'] = new_settings['conc_instrument']
            if 'conc_serial' in new_settings:
                config_data['conc']['serial_port'] = new_settings['conc_serial']
            if 'conc_baudrate' in new_settings:
                config_data['conc']['baudrate'] = int(new_settings['conc_baudrate'])
            if 'conc_ip' in new_settings:
                config_data['conc']['wifi_ip'] = new_settings['conc_ip']
            if 'conc_port' in new_settings:
                config_data['conc']['port'] = int(new_settings['conc_port'])
            if 'time_delay' in new_settings: 
                config_data['settings']['time_delay'] = float(new_settings['time_delay'])
            if 'camera_enabled' in new_settings:
                config_data['camera']['enabled'] = bool(new_settings['camera_enabled'])
            if 'camera_index' in new_settings:
                config_data['camera']['index'] = int(new_settings['camera_index'])

            with open(config_absolute_path, 'w', encoding='utf-8') as f:
                json.dump(config_data, f, indent=2, ensure_ascii=False)
            
            self.logger.info("✅ config.json 已更新")
            db.reference(f'{old_project_name}/control/config_update').delete()

            self.cfg = Config(self.config_file)

            if old_project_name != new_project_name:
                self.logger.info(f"🔄 專案切換中...")
                if self.process and self.process.running:
                    self.stop_process()
                
                time.sleep(1.0)
                self._setup_listeners()
                
                time.sleep(1.0) 
                if not (self.process and self.process.running):
                    db.reference(f'{new_project_name}/status').set({
                        'state': 'stopped',
                        'message': '切換完畢，後端程式已就緒'
                    })

                    if self.cfg.CAMERA_ENABLED:
                        self._start_camera_preview(self.cfg.CAMERA_INDEX)
                    else:
                        self._stop_camera_preview()
            else:
                if self.process and self.process.running:
                    self.logger.info("🔄 偵測到參數變更，將重新整理以套用設定...")
                    self.stop_process()
                    self.start_process()

            self._push_current_config_to_firebase()

        except Exception as e:
            self.logger.error(f"❌ 更新設定檔失敗: {e}")

    def _command_handler(self, event):
        if event.data is None or event.data == "": return
        command = str(event.data).lower()
        
        if command in ['start', 'stop', 'preview_stop'] or command.startswith('preview_'):
            try:
                db.reference(f'{self.cfg.PROJECT_NAME}/control/command').set("")
            except: pass

        if command == "start":
            self.logger.info(f"📩 收到指令: {command}")
            self.start_process()
        elif command == "stop":
            self.logger.info(f"📩 收到指令: {command}")
            self.stop_process()
        elif command == "preview_stop":
            self._stop_camera_preview()
        elif command.startswith("preview_"):
            try:
                index = int(command.split("_")[1])
                # 若已經在預覽同一顆鏡頭，則關閉 (Toggle 行為)
                if hasattr(self, 'preview_camera') and self.preview_camera and self.preview_camera.running and self.preview_camera.camera_index == index:
                    self._stop_camera_preview()
                else:
                    self._start_camera_preview(index)
            except Exception as e:
                self.logger.error(f"預覽指令處理失敗: {e}")

    def _hardware_scan_loop(self):
        last_ports = []
        last_cams = []
        while True:
            # 1. 偵測 COM Ports
            try:
                current_ports = [port.device for port in serial.tools.list_ports.comports()]
                if current_ports != last_ports:
                    db.reference(f'{self.cfg.PROJECT_NAME}/status/available_ports').set(current_ports)
                    last_ports = current_ports
            except Exception:
                pass
            
            # 2. 偵測 USB 鏡頭 (僅在系統暫停/待機時偵測)
            try:
                if self.process is None or not self.process.running:
                    current_cams = []
                    cam_names = []
                    try:
                        graph = FilterGraph()
                        cam_names = graph.get_input_devices()

                        for i, name in enumerate(cam_names):
                            current_cams.append({
                                "index": i, 
                                "name": f"{name}"
                            })
                    except Exception as e:
                        self.logger.warning(f"獲取視訊鏡頭清單失敗: {e}")
                            
                    if current_cams != last_cams:
                        db.reference(f'{self.cfg.PROJECT_NAME}/status/available_cameras').set(current_cams)
                        last_cams = current_cams
            except Exception:
                pass
            time.sleep(3)

    def start_process(self):
        if self.process is not None and self.process.running:
            return 
        self._stop_camera_preview()
        try:
            current_cfg = Config(self.config_file)
            self.process = RunProcedures(current_cfg)
            self.process_thread = threading.Thread(target=self.process.run, daemon=True)
            self.process_thread.start()

            db.reference(f'{self.cfg.PROJECT_NAME}/status').update({
                'state': 'connecting',
                'message': '等待連線中...'
            })
            
        except Exception as e:
            self.logger.error(f"❌ 啟動失敗: {e}")
            db.reference(f'{self.cfg.PROJECT_NAME}/status').update({
                'state': 'stopped', 
                'message': f'啟動失敗: {str(e)}'
            })

    def stop_process(self):
        if self.process is None:
            return

        self.logger.info("🛑 正在停止後端程序...")
        db.reference(f'{self.cfg.PROJECT_NAME}/status').update({
            'state': 'connecting',
            'message': '正在停止...'
        })
        self.process.stop()
        if self.process_thread:
            self.process_thread.join(timeout=1.0)
                    
        db.reference(f'{self.cfg.PROJECT_NAME}/status').update({
            'state': 'stopped',
            'message': '使用者手動停止'
        })
        self.process = None
        self.logger.info("✅ 後端程序已停止")

    def run(self):
        threading.Thread(target=self._hardware_scan_loop, daemon=True).start()

        url = (f"{self.cfg.MAP_URL}?"
               f"id={self.cfg.DB_ID}&"
               f"path={self.cfg.PROJECT_NAME}&"
               f"key={self.cfg.API_KEY}&"
               f"role=admin")
        
        webbrowser.open(url)
        
        self.logger.info("🧹 初始化狀態為 Stopped...")
        db.reference(f'{self.cfg.PROJECT_NAME}/status').set({
            'state': 'stopped',
            'message': '後端程式已就緒'
        })

        self._push_current_config_to_firebase()
        self._setup_listeners()
        
        self.logger.info("🟢 後端程式運作中 (按 Ctrl+C 結束)")
        
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            self.logger.info("👋 正在關閉系統...")
        finally:
            if self.process:
                self.stop_process() 
            
            db.reference(f'{self.cfg.PROJECT_NAME}/status').update({
                'state': 'offline',
                'message': '後端程式已關閉'
            })
            
            os._exit(0)

if __name__ == "__main__":
    ctrl = SystemController()
    ctrl.run()