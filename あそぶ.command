#!/bin/zsh
cd -- "${0:A:h}" || exit 1
exec python3 - <<'PY'
import functools
import http.server
import signal
import webbrowser

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory='.')
with http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler) as server:
    url = f'http://127.0.0.1:{server.server_port}/'
    print(f'ぷち、ぽこ。 {url}', flush=True)
    print('10分で自動終了します。もう一度遊ぶときは、このファイルを開いてください。', flush=True)
    def stop(*_):
        raise SystemExit(0)
    signal.signal(signal.SIGALRM, stop)
    signal.alarm(600)
    webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
PY
