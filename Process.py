import logging
import threading
import queue
import time
from datetime import datetime
from Procedure.GPSReader import GPSReader
from Procedure.ConcentrationReader import ConcentrationReader
from Procedure.FirebaseManager import FirebaseManager
from Procedure.BackupManager import BackupManager

logger = logging.getLogger(__name__)

class RunProcedures:
    def __init__(self, cfg):
        self.cfg = cfg
        self.running = False

        self.gps = GPSReader()
        self.conc = ConcentrationReader()
        self.fb = FirebaseManager(
            key_path=self.cfg.FIREBASE_KEY, 
            db_url=self.cfg.DB_URL
        )
        self.backup = BackupManager(self.cfg.PROJECT_NAME)
        self.is_backup_started = False

        self.gps.wifi_ip = self.cfg.GPS_IP
        self.gps.port = self.cfg.GPS_PORT  
        self.gps.gps_queue = self.cfg.GPS_QUEUE

        self.conc.serial_port = self.cfg.CONC_PORT
        self.conc.baud_rate = self.cfg.CONC_BAUDRATE
        self.conc.unit = self.cfg.CONC_UNIT
        self.conc.conc_queue = self.cfg.CONC_QUEUE 

        self.fb.project_name = self.cfg.PROJECT_NAME
        self.fb.data_queue = self.cfg.SHARED_QUEUE 

    def _ensure_backup_active(self):
        if not self.is_backup_started:
            try:
                self.backup.start()
                self.is_backup_started = True
            except Exception as e:
                logger.error(f"啟動備份失敗: {e}")

    def _queue_merger(self):
        latest_conc_cache = {
            'val': 0.0, 
            'unit': self.conc.unit if hasattr(self.conc, 'unit') else '', 
            'last_update': time.time()
        }
        
        last_valid_gps = {
            'lat': None,
            'lon': None
        }

        SENSOR_TIMEOUT_SEC = 2.0
        last_gps_arrival_time = time.time()
        last_upload_time = time.time()
        GPS_GRACE_PERIOD = 2.0 
        last_processed_ts = ""
        
        # 🔥 新增：儲存 GPS 資料的緩衝區，用於時間延遲匹配
        gps_buffer = []

        while self.running:
            try:
                # --- A. 更新濃度緩存 ---
                conc_alive = True
                while not self.conc.conc_queue.empty():
                    try:
                        c_data = self.conc.conc_queue.get_nowait()
                        if c_data is None:
                            if self.running:
                                self.fb.data_queue.put(None)
                            conc_alive = False
                            self.running = False 
                            break
                        latest_conc_cache['val'] = c_data['conc']
                        if 'unit' in c_data: latest_conc_cache['unit'] = c_data['unit']
                        latest_conc_cache['last_update'] = time.time()
                    except queue.Empty:
                        break
                if not conc_alive: break
                
                # --- B. 處理 GPS 與緩衝區寫入 ---
                try:
                    gps_data = self.gps.gps_queue.get(timeout=0.1)
                    
                    if gps_data is None:
                        if self.running: self.fb.data_queue.put(None)
                        break

                    # 過濾重複時間戳
                    current_ts = gps_data.get('timestamp', '')
                    if current_ts != last_processed_ts:
                        last_processed_ts = current_ts
                        
                        # 🔥 把 GPS 座標加入緩衝區，並記錄進入系統的精準時間
                        gps_buffer.append({'sys_time': time.time(), 'data': gps_data})
                        last_gps_arrival_time = time.time() 

                except queue.Empty:
                    pass

                # --- C. 取出已達延遲時間的 GPS 進行配對 ---
                current_time = time.time()
                # 扣除設定的延遲時間 (秒)
                target_time = current_time - self.cfg.TIME_DELAY
                
                # 若緩衝區有資料，且其系統進入時間小於等於目標時間，代表它「熟成」了
                while len(gps_buffer) > 0 and gps_buffer[0]['sys_time'] <= target_time:
                    delayed_gps_data = gps_buffer.pop(0)['data']
                    
                    if delayed_gps_data['lat'] is not None and delayed_gps_data['lon'] is not None:
                        last_valid_gps['lat'] = delayed_gps_data['lat']
                        last_valid_gps['lon'] = delayed_gps_data['lon']

                    # 🔥 將 N 秒前的 GPS 座標，與「當下最新」的濃度匹配
                    delayed_gps_data['conc'] = latest_conc_cache['val']
                    delayed_gps_data['conc_unit'] = latest_conc_cache['unit']
                    
                    time_diff = current_time - latest_conc_cache['last_update']
                    if time_diff > SENSOR_TIMEOUT_SEC:
                        delayed_gps_data['status'] = 'Conc Lost'
                        delayed_gps_data['conc'] = 0.0
                    
                    self.fb.data_queue.put(delayed_gps_data)
                    self._ensure_backup_active()
                    self.backup.write(delayed_gps_data)
                    
                    last_upload_time = current_time

                # === 處理 GPS 遺失狀況 (緩衝區為空且超時) ===
                if len(gps_buffer) == 0:
                    is_gps_really_lost = (current_time - last_gps_arrival_time > GPS_GRACE_PERIOD)
                    is_time_to_fill = (current_time - last_upload_time >= 1.0)

                    if is_gps_really_lost and is_time_to_fill:
                        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                        
                        no_gps_data = {
                            "timestamp": now_str,
                            "lat": None, 
                            "lon": None, 
                            "alt": 0,
                            "status": "GPS Lost",
                            "conc": latest_conc_cache['val'],
                            "conc_unit": latest_conc_cache['unit']
                        }
                        
                        time_diff = current_time - latest_conc_cache['last_update']
                        if latest_conc_cache['last_update'] > 0 and time_diff > SENSOR_TIMEOUT_SEC:
                            no_gps_data['status'] = 'All Lost'

                        self.fb.data_queue.put(no_gps_data)
                        self._ensure_backup_active()
                        self.backup.write(no_gps_data)
                        
                        last_upload_time = current_time

            except Exception as e:
                logger.error(f"合併程序錯誤: {e}")
                time.sleep(1)

        if self.running:
            self.fb.data_queue.put(None)

    def stop(self):
        self.running = False
        self.gps.stop()
        self.conc.stop()    
        self.fb.stop()
        if self.is_backup_started:
            self.backup.stop()
            self.is_backup_started = False
   
    def run(self):
        self.running = True
        logger.info("---程式開始---")

        self.conc.run()
        self.gps.run()      

        merger_thread = threading.Thread(target=self._queue_merger, daemon=True)
        merger_thread.start()

        try:
            self.fb.run()
        finally:
            self.stop()   
            self.running = False