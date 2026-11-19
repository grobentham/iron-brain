import time, urllib.request
UA={"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36"}
for side in ("BID","ASK"):
    for y,m in ((2019,5),(2024,2)):
        url=f"https://datafeed.dukascopy.com/datafeed/XAUUSD/{y}/{m:02d}/{side}_candles_hour_1.bi5"
        t=time.time()
        try:
            b=urllib.request.urlopen(urllib.request.Request(url,headers=UA),timeout=30).read(); print(side,y,m,len(b),"bytes",round(time.time()-t,1),"s",flush=True)
        except Exception as e: print(side,y,m,"ERR",repr(e),round(time.time()-t,1),"s",flush=True)
