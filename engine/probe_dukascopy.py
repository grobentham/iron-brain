import lzma, struct, urllib.request, datetime as dt
UA={"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36"}
for inst in ("USATECHIDXUSD","XAUUSD"):
    for y,m in ((2012,0),(2019,5),(2026,9)):
        url=f"https://datafeed.dukascopy.com/datafeed/{inst}/{y}/{m:02d}/BID_candles_hour_1.bi5"
        try:
            b=urllib.request.urlopen(urllib.request.Request(url,headers=UA),timeout=40).read(); raw=lzma.decompress(b) if b else b""
            n=len(raw)//24; rows=[struct.unpack(">5if",raw[k*24:(k+1)*24]) for k in (0,n//2,n-1)] if n else []
            print(inst,y,m+1,"bytes",len(b),"candles",n,rows)
        except Exception as e:
            print(inst,y,m+1,"ERROR",repr(e))
