# Iron Brain Live Bridge

A tiny Chrome/Opera extension that lets the Iron Brain desk use your live TradingView price.

It reads the **titles** of your open TradingView tabs (TradingView puts the symbol and last price there, for example
`NQ1! 21,345.50 ▲ +0.40%`) and hands them to the Iron Brain page every five seconds. It does not read the chart,
your account or anything else, stores nothing, and sends nothing over the network.

Install: open `chrome://extensions` (or `opera://extensions`), turn on Developer mode, choose **Load unpacked** and
pick this `live-bridge` folder. Then open an NQ/MNQ or gold chart on TradingView and the Iron Brain page.
