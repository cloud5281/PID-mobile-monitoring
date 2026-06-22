import logging
import threading
import time
import re
import random
import serial

from datetime import datetime

logger = logging.getLogger(__name__)

class ConcentrationReader:
    def __init__(self):
        self.serial_port = None
        self.baud_rate = 9600
        self.unit = None 
        self.conc_queue = None

        self.timeout_limit = 30

        self.running = False
        self.serial = None
        
    def _cleanup(self):
        """釋放資源"""
        if self.serial is None:
            logger.info("🔌 Conc 資源已釋放。")
            return
        try:
            self.serial.close()
        except Exception:
            pass
        self.serial = None
        logger.info("🔌 Conc 連線中斷，資源已釋放。")

    def stop(self):
        self.running = False

    # ppbRAE3000
    def _producer(self):
        """背景執行緒：持續讀取 PID 數據並放入 Queue"""
        first_failure_time = None
        while self.running:
            try:
                # 1. 嘗試連線 (如果尚未連線)
                if self.serial is None or not self.serial.is_open:
                    logger.info(f"📡 嘗試連線至 {self.serial_port}")
                    connect_start_time = time.time()
                    while True:
                        if not self.running: return
                        
                        try:
                            # 嘗試開啟連線
                            self.serial = serial.Serial(
                                port=self.serial_port,
                                baudrate=self.baud_rate,
                                timeout=5 # 這裡的 timeout 是指連上後的讀取逾時
                            )
                            # 如果成功執行到這行，代表連線成功，跳出迴圈
                            break 
                        except serial.SerialException:
                            # 如果開啟失敗 (例如找不到 COM Port)
                            # 檢查是否已經嘗試超過 5 秒
                            if time.time() - connect_start_time > 5.0:
                                raise # 超過時間，將錯誤往外拋，讓外層 catch 處理
                            
                            # 還沒超過時間，休息 1 秒後重試
                            time.sleep(1)
                    logger.info(f"✅ Conc 連線成功！ {self.serial_port}")
                    # 連線成功，重置失敗計時器
                    first_failure_time = None  

                # 2. 發送指令 (模擬按下 'R')
                self.serial.write(b'R')
                
                # 3. 讀取回應
                raw_data = self.serial.readline()
                
                if not raw_data:
                    time.sleep(0.1) 
                    continue

                # 4. 解析數據
                try:
                    decoded_str = raw_data.decode('ascii', errors='ignore').strip()
                    # 抓取浮點數或整數
                    match = re.search(r"[-+]?\d*\.\d+|\d+", decoded_str)
                    
                    if match:
                        val = float(match.group())
                        conc_packet = {
                            "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                            "conc": val,
                            "conc_unit": self.unit
                        }
                        if self.conc_queue:
                            self.conc_queue.put(conc_packet)
                    else:
                        if decoded_str:
                            logger.warning(f"⚠️ Conc 回傳無法解析: {decoded_str}")

                except ValueError:
                    logger.warning(f"⚠️ Conc 數值轉換錯誤: {decoded_str}")

                time.sleep(0.1)

            except serial.SerialException as e:
                logger.error(f"❌ Conc 連線失敗: {e}")
                self._cleanup() 

                if not self.running: break

                current_time = time.time()
                # 如果是連續失敗的第一筆，紀錄開始時間
                if first_failure_time is None:
                    first_failure_time = current_time

                elapsed = current_time - first_failure_time       
                
                if elapsed >= self.timeout_limit:
                    logger.error(f"❌ Conc 已超過 {self.timeout_limit} 秒無法連線，停止嘗試。")
                    self.running = False 
                    break 
                else:
                    time.sleep(5)       # 等待 5 秒後再嘗試

            except Exception as e:
                logger.error(f"❌ Conc 未預期錯誤: {e}")
                time.sleep(1)
        
        self._cleanup()
        if self.running:
            logger.error("🏁 逾時連線，Conc 讀取執行緒已停止。")
        self.conc_queue.put(None)

    # def _fake_producer(self):
    #     while self.running:
    #         try:
    #             # 模擬讀取濃度 
    #             fake_val = round(random.uniform(200, 1500), 2)
                
    #             # 封裝資料
    #             conc_packet = {
    #                 "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    #                 "conc": fake_val,
    #                 "conc_unit": self.unit
    #             }
                
    #             # 塞入 Queue
    #             self.conc_queue.put(conc_packet)
                
    #             # 控制頻率 (盡量接近 1 秒 1 次，與 GPS 同步)
    #             time.sleep(1) 
                
    #         except Exception as e:
    #             logger.error(f"濃度讀取錯誤: {e}")
    #             time.sleep(1)

    def run(self):
        self.running = True
        logger.info(f"🚀 開始處理 Conc 數據...")
        threading.Thread(target=self._producer, daemon=True).start()

### ---test--- ###
if __name__ == "__main__":
    import queue

    conc_queue = queue.Queue()
    conc_reader = ConcentrationReader()
    conc_reader.serial_port = 'COM3'  
    conc_reader.unit = 'ppb'
    conc_reader.conc_queue = conc_queue
    conc_reader.run()

    try:
        while True:
            try:
                data = conc_queue.get(timeout=2)
                if data:
                    print(f"Received Concentration Data: {data}")
            except queue.Empty:
                print("No data received in the last 5 seconds.")
    except KeyboardInterrupt:
        print("Stopping Concentration Reader...")
        conc_reader.stop()
        time.sleep(2)