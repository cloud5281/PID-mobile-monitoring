import csv
import os
import logging
from datetime import datetime

logger = logging.getLogger(__name__)

class BackupManager:
    def __init__(self, project_name):
        self.project_name = project_name
        self.backup_dir = "backups"
        self.file = None
        self.writer = None
        self.fieldnames = ['timestamp', 'lat', 'lon', 'alt', 'conc', 'conc_unit', 'status']

    def start(self):
        try:
            if not os.path.exists(self.backup_dir): os.makedirs(self.backup_dir)
            now_str = datetime.now().strftime("%Y%m%d_%H%M%S")
            filename = f"{self.backup_dir}/{self.project_name}_{now_str}.csv"
            self.file = open(filename, mode='w', newline='', encoding='utf-8-sig')
            self.writer = csv.DictWriter(self.file, fieldnames=self.fieldnames, extrasaction='ignore')
            self.writer.writeheader()
            self.file.flush()
            logger.info(f"💾 本地備份已啟動: {filename}")
        except Exception as e:
            logger.error(f"❌ 無法建立備份檔案: {e}")

    def write(self, data):
        if self.file and self.writer and data:
            try:
                self.writer.writerow(data)
                self.file.flush()
            except Exception as e:
                logger.error(f"⚠️ 寫入備份失敗: {e}")

    def stop(self):
        if self.file:
            try:
                self.file.close()
                logger.info("💾 備份檔案已存檔關閉。")
            except Exception as e:
                logger.error(f"❌ 關閉備份檔案錯誤: {e}")
            finally:
                self.file = None
                self.writer = None