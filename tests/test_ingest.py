import datetime as dt
import unittest
from scripts.ingest import completed_date, parse_bars

class IngestTest(unittest.TestCase):
    def test_before_close_and_holiday(self):
        dates = [dt.date(2026,10,2), dt.date(2026,10,9)]
        self.assertEqual(completed_date(dt.datetime(2026,10,9,7,5), dates), dates[0])
        self.assertEqual(completed_date(dt.datetime(2026,10,9,16,45), dates), dates[1])
    def test_invalid_candle_rejected(self):
        data = {'rc':0,'data':{'klines':['2026-10-09,10,12,11,9,100,1000,0,2,0,1']}}
        with self.assertRaises(ValueError): parse_bars(data,dt.date(2026,10,9))
    def test_duplicate_dates_rejected(self):
        line='2026-10-09,10,10,11,9,100,1000,0,2,0,1'
        with self.assertRaises(ValueError): parse_bars({'rc':0,'data':{'klines':[line,line]}},dt.date(2026,10,9))

if __name__ == '__main__': unittest.main()
