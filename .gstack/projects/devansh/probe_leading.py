import http.server, socketserver, threading, functools, sys
from playwright.sync_api import sync_playwright
ROOT="/home/devansh/colosseum/web"
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self,*a): pass
h=functools.partial(Q,directory=ROOT)
s=socketserver.TCPServer(("127.0.0.1",0),h); port=s.server_address[1]
threading.Thread(target=s.serve_forever,daemon=True).start()
with sync_playwright() as p:
    b=p.chromium.launch(args=["--no-sandbox"]); pg=b.new_page(viewport={"width":1280,"height":800})
    for page in ["index.html","limits.html","402.html","dashboard.html"]:
        pg.goto("http://127.0.0.1:%d/%s"%(port,page),wait_until="networkidle"); pg.wait_for_timeout(600)
        out=pg.evaluate("""() => {
          const res=[];
          document.querySelectorAll('*').forEach(el=>{
            const txt=(el.textContent||'').trim();
            if(!txt) return;
            // only leaf-ish elements (no element children with text of their own)
            if([...el.children].some(c=>(c.textContent||'').trim().length>10)) return;
            const cs=getComputedStyle(el);
            const fs=parseFloat(cs.fontSize); const lh=parseFloat(cs.lineHeight);
            if(!fs||!lh) return;
            const r=lh/fs;
            const rect=el.getBoundingClientRect();
            const lines=Math.round(rect.height/lh);
            if(r<1.32) res.push({tag:el.tagName.toLowerCase(),cls:el.className.toString().slice(0,40),
              fs:+fs.toFixed(1),lh:+lh.toFixed(1),ratio:+r.toFixed(3),lines,
              upper:cs.textTransform, chars:txt.length, sample:txt.slice(0,44)});
          });
          return res;
        }""")
        print("=== %s : %d elements under 1.32 ==="%(page,len(out)))
        for o in out[:12]:
            print("   %-6s .%-24s %5.1f/%-6.1f = %-6.3f lines=%-3d %-9s chars=%-4d %r"
                  %(o['tag'],o['cls'],o['fs'],o['lh'],o['ratio'],o['lines'],o['upper'],o['chars'],o['sample']))
    b.close()
s.shutdown()
