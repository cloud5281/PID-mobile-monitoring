import json
import queue

from pathlib import Path

class Config:
    def __init__(self, config_name):
        # 1. 取得目前程式碼所在的資料夾路徑 (取代 os.path.dirname)
        self.BASE_DIR = Path(__file__).parent.resolve()
        # 2. 組合設定檔的完整路徑 (取代 os.path.join)
        config_path = self.BASE_DIR / config_name
        # 3. 檢查檔案是否存在 (取代 os.path.exists)
        if not config_path.exists():
            raise FileNotFoundError(f"找不到設定檔: {config_path}")
        # 4. 讀取 JSON
        with config_path.open("r", encoding="utf-8") as f:
            data = json.load(f)

        # --- Firebase 分類 --- 
        # 若沒有輸入 firebase_id 和 api_key，預設是我的
        fb = data.get("firebase", {})
        self.DB_ID = fb.get("db_id")            
        self.API_KEY = fb.get("api_key")
        self.FIREBASE_KEY = fb.get("key_path")
        self.REGION = fb.get("region")
        self.DB_URL = fb.get("db_url")

        # --- GPS 分類 ---
        gps = data.get("gps", {})
        self.GPS_IP = gps.get("wifi_ip")
        self.GPS_PORT = int(gps.get("port"))

        # --- CONC 分類 ---
        conc = data.get("conc", {})
        self.CONC_PORT = conc.get("serial_port") 
        self.CONC_BAUDRATE = int(conc.get("baudrate", 9600))
        self.CONC_UNIT = conc.get("unit")

        # --- Settings 分類 ---
        stg = data.get("settings", {})
        self.PROJECT_NAME = stg.get("project_name")
        self.TIME_DELAY = float(stg.get("time_delay"))
        self.MAP_URL = stg.get("map_url")

        # --- 衍生變數 (自動生成) ---
        self._generate_urls()

        # --- 固定參數 ---
        self.GPS_QUEUE = queue.Queue()      # 接收 GPS 數據
        self.CONC_QUEUE = queue.Queue()     # 接收 CONC 數據
        self.SHARED_QUEUE = queue.Queue()   # 合併 GPS 和 CONC 數據，以上傳至 firebase

    def _generate_urls(self):
        if not self.DB_URL:
            if self.REGION == "us-central1":
                self.DB_URL = f"https://{self.DB_ID}.firebaseio.com"
            else:
                self.DB_URL = f"https://{self.DB_ID}-default-rtdb.{self.REGION}.firebasedatabase.app"