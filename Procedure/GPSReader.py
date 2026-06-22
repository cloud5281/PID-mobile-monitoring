import socket
import logging
import pynmea2
import threading
import queue
import time

from datetime import datetime

logger = logging.getLogger(__name__)

class GPSReader:
    def __init__(self):
        # 給定
        self.wifi_ip = None
        self.port = None
        self.gps_queue = None
        # 內部
        self.timeout_limit = 30 

        self.socket = None   
        self.file_obj = None 
        self.latest_data = {
            "timestamp": "", 
            "lat": 0.0, 
            "lon": 0.0, 
            "alt": '?', 
            "status": "V"
        }     # 緩存最新資料
        self.last_yield_time = None
        self.running = False

    def _cleanup(self):
        """明確釋放所有連線資源"""
        if self.socket is None and self.file_obj is None:
            logger.info("🔌 GPS 資源已釋放。")
            return
        
        try:
            self.file_obj.close()
        except Exception: 
            pass
        finally:
            self.file_obj = None
            
        try:
            self.socket.close()
        except Exception: 
            pass
        finally:
            self.socket = None
        logger.info("🔌 GPS 連線中斷，資源已釋放。")
    
    def stop(self):
        self.running = False

    def _producer(self):
        """
        背景執行緒：
        - 每 5 秒嘗試重連一次
        - 若累積 30 秒連不上則自動終止
        持續讀取資料塞入 Queue
        """
        first_failure_time = None  # 紀錄第一次失敗的時間點

        while self.running:
            if not self.running: return
            
            try:
                logger.info(f"📡 嘗試連線至 {self.wifi_ip}: {self.port}")
                self.socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                self.socket.settimeout(5)
                self.socket.connect((self.wifi_ip, self.port))
                # --- 連線成功 ---
                logger.info(f"✅ GPS 連線成功！ {self.wifi_ip}: {self.port}")

                first_failure_time = None  # 重置失敗時間
                self.file_obj = self.socket.makefile('r', encoding='utf-8', errors='ignore')
                for line in self.file_obj:
                    if not self.running: break
                    self._parse_and_push(line.strip())
                self._cleanup()
            
            # --- 連線失敗 ---
            except (socket.timeout, socket.error, ConnectionRefusedError):
                if not self.running: break
                current_time = time.time()
                # 如果是連續失敗的第一筆，紀錄開始時間
                if first_failure_time is None:
                    first_failure_time = current_time

                elapsed = current_time - first_failure_time       
                if elapsed >= self.timeout_limit:
                    logger.error(f"❌ GPS 已超過 {self.timeout_limit} 秒無法連線，停止嘗試。")
                    self.running = False # 關閉主迴圈標記
                    break
                else:
                    logger.warning(f"⚠️ GPS 連線失敗，5 秒後重試...")
                    self._cleanup()
                    time.sleep(5)       # 等待 5 秒後再嘗試

        if self.running:
            logger.error("🏁 逾時連線，GPS 讀取執行緒已停止。")
        self.gps_queue.put(None)

    def _parse_and_push(self, line):
        """解析 NMEA 並確保一秒一筆放入 Queue"""
        if not line.startswith('$'):
            return
        
        try:
            msg = pynmea2.parse(line)
            if isinstance(msg, pynmea2.types.talker.RMC):
                if msg.status == 'A' and msg.latitude and msg.longitude:
                    self.latest_data.update({
                        "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                        "lat": msg.latitude, 
                        "lon": msg.longitude, 
                        "status": "A"
                    })
                else:
                    # 定位中或無效數據 -> 只更新時間，狀態設為 V
                    self.latest_data.update({
                        "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                        "status": "V"
                    })
            elif isinstance(msg, pynmea2.types.talker.GGA):     # 高度資訊
                if msg.altitude:
                    self.latest_data["alt"] = msg.altitude

            # 檢查秒數是否改變，決定是否塞入 Queue
            curr_t = self.latest_data["timestamp"]
            if self.latest_data["status"] == "A" and \
               curr_t != self.last_yield_time and \
               self.latest_data["lat"] != 0:
                self.last_yield_time = curr_t
                self.gps_queue.put(self.latest_data.copy())

        except pynmea2.ParseError as e:
            logger.warning(f"GPS NMEA 解析失敗 (Checksum Error?): {e} | 原始資料: {line}")
            
        except Exception as e:
            logger.error(f"GPS 處理未預期錯誤: {e}")

    def run(self):
        self.running = True
        # 啟動背景執行緒 (daemon=True 確保主程式關閉時執行緒也結束)
        logger.info(f"🚀 開始處理 GPS 數據...")
        threading.Thread(target=self._producer, daemon=True).start()

### ---test--- ###
if __name__ == "__main__":
    import queue
    import time

    gps_queue = queue.Queue()
    gps_reader = GPSReader()
    gps_reader.wifi_ip = "192.168.199.103"
    gps_reader.port = 11123
    gps_reader.gps_queue = gps_queue
    gps_reader.run()

    try:
        while True:
            data = gps_queue.get()
            if data is None:
                print("GPS 讀取執行緒已停止")
                break
            print(f"收到 GPS 數據: {data}")
    except KeyboardInterrupt:
        gps_reader.stop()