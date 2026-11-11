// fxctl — helper nativo (macOS) do MCP firefox-qa. Só pixels.
// Análise de imagem (usada pelo QA completo):
//   fxctl analisar <png> <dir>            OCR (Vision) + detecção de botões, campos, opções e rótulos
//   fxctl ocr <png...> | difreg | comparar | miniaturas
// Janela do Firefox do usuário (sem roubar foco; clique de mouse não chega em segundo plano):
//   fxctl shot <dir> | click <x> <y> [page|window] | key <back|forward|reload|tab|enter|escape> | url | peek <jpg>
import Foundation
import CoreGraphics
import ScreenCaptureKit
import AppKit
import ApplicationServices
import Vision
import ImageIO
import UniformTypeIdentifiers

_ = NSApplication.shared

// MARK: - Globais
var contentTopPt: CGFloat = 86          // altura da barra de abas/URL do Firefox (fora da página)
var scrollSign: Int32 = -1              // sinal do wheel para "rolar para baixo" (descoberto em runtime)
var wheelGain: Double = 1.0             // px de scroll real por px pedido
var curYpx = 0                          // scroll atual (px do bitmap), relativo ao topo
var maxYpx = Int.max                    // scroll máximo conhecido
var G: Win! = nil
let src = CGEventSource(stateID: .hidSystemState)

func nowStamp() -> String { let f = DateFormatter(); f.dateFormat = "HH:mm:ss.SSS"; return f.string(from: Date()) }
func msSince(_ t: Date) -> Int { Int(Date().timeIntervalSince(t) * 1000) }
func fail(_ m: String) -> Never { FileHandle.standardError.write((m + "\n").data(using: .utf8)!); exit(1) }
func log(_ m: String) { FileHandle.standardError.write((m + "\n").data(using: .utf8)!) }

// MARK: - Janela
struct Win { var id: CGWindowID; var pid: pid_t; var frame: CGRect }

func findFirefox() -> Win? {
    guard let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] else { return nil }
    var best: Win? = nil; var bestScore = -1.0
    for w in list {
        guard (w[kCGWindowOwnerName as String] as? String) == "Firefox",
              (w[kCGWindowLayer as String] as? Int) == 0,
              let bdAny = w[kCGWindowBounds as String],
              let num = w[kCGWindowNumber as String] as? Int,
              let pid = w[kCGWindowOwnerPID as String] as? Int else { continue }
        var r = CGRect.zero
        guard CGRectMakeWithDictionaryRepresentation(bdAny as! CFDictionary, &r) else { continue }
        if r.width < 400 || r.height < 300 { continue }
        let on = (w[kCGWindowIsOnscreen as String] as? Bool) ?? false
        let s = Double(r.width * r.height) + (on ? 1e9 : 0)
        if s > bestScore { bestScore = s; best = Win(id: CGWindowID(num), pid: pid_t(pid), frame: r) }
    }
    return best
}

// MARK: - Captura (ScreenCaptureKit, funciona com a janela atrás de outras)
var cachedSC: SCWindow? = nil
func capture() -> CGImage? {
    var out: CGImage? = nil
    let sem = DispatchSemaphore(value: 0)
    let win = G!
    Task {
        defer { sem.signal() }
        if cachedSC == nil || cachedSC!.windowID != win.id {
            let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            cachedSC = content?.windows.first { $0.windowID == win.id }
        }
        guard let w = cachedSC else { return }
        let f = SCContentFilter(desktopIndependentWindow: w)
        let c = SCStreamConfiguration()
        c.width = Int(w.frame.width * 2); c.height = Int(w.frame.height * 2)
        c.showsCursor = false
        c.scalesToFit = true
        c.captureResolution = .best
        c.ignoreShadowsSingleWindow = true
        out = try? await SCScreenshotManager.captureImage(contentFilter: f, configuration: c)
    }
    sem.wait()
    return out
}

// MARK: - Bitmap
final class Bmp {
    let w: Int; let h: Int; var d: [UInt8]
    init(_ img: CGImage) {
        w = img.width; h = img.height
        d = [UInt8](repeating: 0, count: w * h * 4)
        let cs = CGColorSpaceCreateDeviceRGB()
        d.withUnsafeMutableBytes { p in
            let ctx = CGContext(data: p.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                space: cs, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
            ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
        }
    }
    @inline(__always) func at(_ x: Int, _ y: Int) -> (Int, Int, Int) {
        let i = (y * w + x) * 4
        return (Int(d[i]), Int(d[i + 1]), Int(d[i + 2]))
    }
}
@inline(__always) func cdist(_ a: (Int, Int, Int), _ b: (Int, Int, Int)) -> Int { abs(a.0 - b.0) + abs(a.1 - b.1) + abs(a.2 - b.2) }

func diffInfo(_ a: Bmp, _ b: Bmp, y0: Int, y1: Int, step: Int = 4, thr: Int = 40) -> (ratio: Double, bbox: CGRect?) {
    if a.w != b.w || a.h != b.h { return (1, nil) }
    var n = 0, tot = 0
    var minX = Int.max, minY = Int.max, maxX = -1, maxY = -1
    var y = max(0, y0)
    let yEnd = min(a.h, y1)
    while y < yEnd {
        var x = 0
        while x < a.w {
            tot += 1
            let i = (y * a.w + x) * 4
            let dd = abs(Int(a.d[i]) - Int(b.d[i])) + abs(Int(a.d[i + 1]) - Int(b.d[i + 1])) + abs(Int(a.d[i + 2]) - Int(b.d[i + 2]))
            if dd > thr { n += 1; if x < minX { minX = x }; if x > maxX { maxX = x }; if y < minY { minY = y }; if y > maxY { maxY = y } }
            x += step
        }
        y += step
    }
    let box: CGRect? = maxX >= 0 ? CGRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1) : nil
    return (tot == 0 ? 0 : Double(n) / Double(tot), box)
}

func saveImage(_ img: CGImage, _ path: String, jpeg: Bool = false, maxW: Int? = nil) {
    var im = img
    if let mw = maxW, img.width > mw {
        let nh = img.height * mw / img.width
        let ctx = CGContext(data: nil, width: mw, height: nh, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        ctx.interpolationQuality = .high
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: mw, height: nh))
        im = ctx.makeImage()!
    }
    let type = jpeg ? UTType.jpeg.identifier : UTType.png.identifier
    guard let d = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, type as CFString, 1, nil) else { return }
    let props: [CFString: Any] = jpeg ? [kCGImageDestinationLossyCompressionQuality: 0.72] : [:]
    CGImageDestinationAddImage(d, im, props as CFDictionary)
    CGImageDestinationFinalize(d)
}

// MARK: - Eventos (enviados direto ao PID: não movem o mouse real nem trazem o Firefox para frente)
func postMouse(_ type: CGEventType, _ p: CGPoint, clickState: Int64 = 1) {
    guard let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: .left) else { return }
    e.setIntegerValueField(.mouseEventClickState, value: clickState)
    e.setIntegerValueField(CGEventField(rawValue: 91)!, value: Int64(G.id))
    e.setIntegerValueField(CGEventField(rawValue: 92)!, value: Int64(G.id))
    e.postToPid(G.pid)
}
func globalPt(_ w: CGPoint) -> CGPoint { CGPoint(x: G.frame.minX + w.x, y: G.frame.minY + w.y) }
func moveTo(_ w: CGPoint) { postMouse(.mouseMoved, globalPt(w)) }
func clickAt(_ w: CGPoint) {
    let p = globalPt(w)
    postMouse(.mouseMoved, CGPoint(x: p.x - 3, y: p.y - 2)); usleep(40000)
    postMouse(.mouseMoved, p); usleep(60000)
    postMouse(.leftMouseDown, p); usleep(45000)
    postMouse(.leftMouseUp, p)
}
func pressKey(_ code: CGKeyCode, cmd: Bool) {
    for down in [true, false] {
        let e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down)
        if cmd { e?.flags = .maskCommand }
        e?.postToPid(G.pid)
        usleep(15000)
    }
}
func wheel(pt: Int) {   // pt > 0 => rolar para baixo
    guard let e = CGEvent(scrollWheelEvent2Source: src, units: .pixel, wheelCount: 1, wheel1: Int32(pt) * scrollSign * -1, wheel2: 0, wheel3: 0) else { return }
    e.location = CGPoint(x: G.frame.midX, y: G.frame.minY + contentTopPt + 200)
    e.setIntegerValueField(CGEventField(rawValue: 91)!, value: Int64(G.id))
    e.postToPid(G.pid)
}
func backKey() { pressKey(33, cmd: true) }      // Cmd+[
func reloadKey() { pressKey(15, cmd: true) }    // Cmd+R

// MARK: - Espera por estabilidade
@discardableResult
func waitStable(minMs: Int = 40, maxMs: Int = 500) -> CGImage? {
    let t = Date()
    var prev: Bmp? = nil; var last: CGImage? = nil
    let topPx = Int(contentTopPt * 2)
    while msSince(t) < maxMs {
        guard let f = capture() else { usleep(20000); continue }
        let b = Bmp(f)
        if let p = prev, diffInfo(p, b, y0: topPx, y1: b.h).ratio < 0.0003, msSince(t) >= minMs { return f }
        prev = b; last = f
        usleep(20000)
    }
    return last
}

// MARK: - Scroll medido por pixels
func rowSigs(_ b: Bmp) -> ([UInt64], [Bool]) {
    let x0 = b.w * 3 / 10, x1 = b.w * 97 / 100
    var sig = [UInt64](repeating: 0, count: b.h), inf = [Bool](repeating: false, count: b.h)
    for y in 0..<b.h {
        var h: UInt64 = 1469598103934665603; var distinct = 0; var last = -1
        var x = x0
        while x < x1 {
            let i = (y * b.w + x) * 4
            let q = (Int(b.d[i] >> 3) << 10) | (Int(b.d[i + 1] >> 3) << 5) | Int(b.d[i + 2] >> 3)
            h = (h ^ UInt64(q)) &* 1099511628211
            if q != last { distinct += 1; last = q }
            x += 3
        }
        sig[y] = h; inf[y] = distinct >= 4
    }
    return (sig, inf)
}
// positivo = conteúdo subiu (rolou para baixo). nil = nada se moveu / indeterminado
func estimateShift(_ a: Bmp, _ b: Bmp) -> Int? {
    let topPx = Int(contentTopPt * 2)
    if diffInfo(a, b, y0: topPx, y1: a.h).ratio < 0.0005 { return nil }
    let (sa, _) = rowSigs(a); let (sb, ib) = rowSigs(b)
    let maxShift = a.h - topPx - 40
    var best = 0, bestScore = 0
    for dy in -maxShift...maxShift where dy != 0 {
        var score = 0
        var y = max(topPx, topPx - dy)
        let yEnd = min(b.h, a.h - dy)
        while y < yEnd { if ib[y] && sb[y] == sa[y + dy] { score += 1 }; y += 1 }
        if score > bestScore { bestScore = score; best = dy }
    }
    return bestScore >= 12 ? best : nil
}

// rola por TECLADO (evento de roda não chega ao Firefox em segundo plano) e mede o deslocamento real em px
var arrowPx = 96.0
func scrollKeys(dir: Int, page: Bool, count: Int = 1) -> Int? {   // dir>0 = para baixo; retorna deslocamento medido (>0 desceu)
    guard let before = capture() else { return nil }
    let bBefore = Bmp(before)
    for _ in 0..<count { pressKey(page ? (dir > 0 ? 121 : 116) : (dir > 0 ? 125 : 126), cmd: false); usleep(12000) }
    guard let after = waitStable(minMs: 80, maxMs: 1000) else { return nil }
    guard let s = estimateShift(bBefore, Bmp(after)) else { return nil }
    if !page && count > 0 { arrowPx = max(10, min(300, Double(abs(s)) / Double(count))) }
    return s
}

// F6/Escape foram removidos de propósito: mexem na barra de endereço do usuário. Se o foco do teclado não estiver
// no conteúdo da página, a rolagem não acontece e a captura sai só com a parte visível.
func ensureContentFocus() {}

func scrollToTop() -> Int {          // devolve quanto rolou (px) = posição original
    var moved = 0
    for _ in 0..<40 {
        guard let s = scrollKeys(dir: -1, page: true) else { break }
        moved += abs(s)
    }
    curYpx = 0
    return moved
}

func gotoScroll(_ target: Int) {
    let viewH = Int(G.frame.height * 2) - Int(contentTopPt * 2)
    for _ in 0..<14 {
        let delta = target - curYpx
        if abs(delta) <= 6 { return }
        let dir = delta > 0 ? 1 : -1
        let usePage = abs(delta) >= viewH * 6 / 10
        let count = usePage ? 1 : max(1, min(25, Int((Double(abs(delta)) / arrowPx).rounded())))
        if let s = scrollKeys(dir: dir, page: usePage, count: count) { curYpx += s }
        else { if dir > 0 { maxYpx = curYpx } else { curYpx = 0 }; return }
    }
}

// MARK: - Página inteira (rola, mede, costura)
struct PageCap {
    var page: CGImage; var chrome: CGImage; var frame0: CGImage; var frame1: CGImage?
    var totalPx: Int; var viewHpx: Int; var originalYpx: Int
}
func capturePage() -> PageCap? {
    ensureContentFocus()
    let original = scrollToTop()
    guard let f0 = waitStable(minMs: 40, maxMs: 500) else { return nil }
    let b0 = Bmp(f0)
    let topPx = Int(contentTopPt * 2)
    let viewH = b0.h - topPx
    var rows = [UInt8](b0.d[(topPx * b0.w * 4)...])
    var prevB = b0
    var frame1: CGImage? = nil
    var total = 0
    for _ in 0..<14 {
        guard let f = { () -> CGImage? in
            pressKey(121, cmd: false)
            return waitStable(minMs: 80, maxMs: 1000)
        }() else { break }
        let b = Bmp(f)
        guard let s = estimateShift(prevB, b), s >= 4 else { break }
        if frame1 == nil { frame1 = f }
        rows.append(contentsOf: b.d[((b.h - s) * b.w * 4)...])
        total += s; prevB = b
    }
    curYpx = total; maxYpx = total
    let hh = rows.count / (b0.w * 4)
    var buf = rows
    let page: CGImage = buf.withUnsafeMutableBytes { p in
        let ctx = CGContext(data: p.baseAddress, width: b0.w, height: hh, bitsPerComponent: 8, bytesPerRow: b0.w * 4,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        return ctx.makeImage()!
    }
    let chrome = f0.cropping(to: CGRect(x: 0, y: 0, width: f0.width, height: topPx))!
    return PageCap(page: page, chrome: chrome, frame0: f0, frame1: frame1, totalPx: total, viewHpx: viewH, originalYpx: original)
}

// MARK: - OCR (segmentado por lacunas: separa botões vizinhos)
struct Seg { var text: String; var r: CGRect; var conf: Float }
// imagens muito altas são reduzidas pelo Vision e perdem texto: processa em faixas sobrepostas
func ocrSegments(_ img: CGImage) -> [Seg] {
    let stripH = 1500, overlap = 140
    if img.height <= stripH + 600 { return ocrOne(img) }
    var all = [Seg]()
    var y = 0
    var strips = [(Int, CGImage)]()
    while y < img.height {
        let h = min(stripH, img.height - y)
        if let c = img.cropping(to: CGRect(x: 0, y: y, width: img.width, height: h)) { strips.append((y, c)) }
        if y + h >= img.height { break }
        y += stripH - overlap
    }
    var results = [[Seg]](repeating: [], count: strips.count)
    DispatchQueue.concurrentPerform(iterations: strips.count) { i in
        var r = ocrOne(strips[i].1)
        for k in r.indices { r[k].r.origin.y += CGFloat(strips[i].0) }
        results[i] = r   // escrita em índices distintos
    }
    for r in results { for sg in r {
        // descarta duplicata da zona de sobreposição
        if all.contains(where: { $0.text == sg.text && abs($0.r.minY - sg.r.minY) < 8 && abs($0.r.minX - sg.r.minX) < 8 }) { continue }
        all.append(sg)
    } }
    return all
}

func ocrOne(_ img: CGImage) -> [Seg] {
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = false
    req.recognitionLanguages = ["pt-BR", "en-US"]
    try? VNImageRequestHandler(cgImage: img, options: [:]).perform([req])
    let W = CGFloat(img.width), H = CGFloat(img.height)
    var out = [Seg]()
    for o in req.results ?? [] {
        guard let c = o.topCandidates(1).first else { continue }
        let s = c.string
        var words: [(String, CGRect)] = []
        var i = s.startIndex
        while i < s.endIndex {
            while i < s.endIndex && s[i] == " " { i = s.index(after: i) }
            if i >= s.endIndex { break }
            let st = i
            while i < s.endIndex && s[i] != " " { i = s.index(after: i) }
            let palavra = String(s[st..<i])
            if palavra.count <= 3 && palavra.allSatisfy({ "|\\/_-—–·.,:;!'`´‘’\"“”()[]{}<>=~^".contains($0) }) { continue }   // bordas lidas como traço
            if let bb = try? c.boundingBox(for: st..<i) {
                let b = bb.boundingBox
                words.append((String(s[st..<i]), CGRect(x: b.minX * W, y: (1 - b.maxY) * H, width: b.width * W, height: b.height * H)))
            }
        }
        var cur: (String, CGRect)? = nil
        let marcadores: Set<String> = ["•", "O", "o", "0", "Q", "□", "☐", "▢", "◯", "○", "[]"]
        for (wi, (w, r)) in words.enumerated() {
            if marcadores.contains(w) && wi + 1 < words.count && (words[wi + 1].1.minX - r.maxX) < 1.3 * r.height && (cur == nil || (r.minX - cur!.1.maxX) > 0.9 * r.height) {
                if let cc = cur { out.append(Seg(text: cc.0, r: cc.1, conf: c.confidence)); cur = nil }
                out.append(Seg(text: "◯", r: r, conf: c.confidence))
                continue
            }
            if let cc = cur {
                let gap = r.minX - cc.1.maxX
                if gap > 1.5 * max(cc.1.height, r.height) { out.append(Seg(text: cc.0, r: cc.1, conf: c.confidence)); cur = (w, r) }
                else { cur = (cc.0 + " " + w, cc.1.union(r)) }
            } else { cur = (w, r) }
        }
        if let cc = cur { out.append(Seg(text: cc.0, r: cc.1, conf: c.confidence)) }
    }
    return out
}

// MARK: - Elementos
struct Elem {
    var id = 0; var kind = ""; var text = ""; var r = CGRect.zero   // r em px da página
    var conf: Float = 0; var fixed = false; var hover = false
    var label = ""; var tipo = ""; var req = false
}

// procura caixa (botão/campo) ao redor do texto, só com pixels
func enclose(_ b: Bmp, _ r: CGRect) -> (rect: CGRect, rightOpen: Bool)? {
    let x0 = Int(r.minX), x1 = Int(r.maxX), y0 = Int(r.minY), y1 = Int(r.maxY)
    let mx = (x0 + x1) / 2, my = (y0 + y1) / 2
    guard x0 - 6 >= 0, y0 - 6 >= 0, x1 + 6 < b.w, y1 + 6 < b.h, x1 > x0, y1 > y0 else { return nil }
    let inner = b.at(x0 - 4, my)
    if cdist(inner, b.at(mx, y0 - 4)) > 24 || cdist(inner, b.at(mx, y1 + 4)) > 24 { return nil }
    let T = 28
    func vline(_ x: Int) -> Bool { // linha vertical em x cobrindo a altura do texto
        guard x >= 0, x < b.w else { return false }
        var n = 0, t = 0; var y = y0; while y <= y1 { t += 1; if cdist(b.at(x, y), inner) > T { n += 1 }; y += 1 }
        return Double(n) / Double(max(t, 1)) >= 0.7
    }
    func hline(_ y: Int) -> Bool {
        guard y >= 0, y < b.h else { return false }
        var n = 0, t = 0; var x = x0; while x <= x1 { t += 1; if cdist(b.at(x, y), inner) > T { n += 1 }; x += 1 }
        return Double(n) / Double(max(t, 1)) >= 0.7
    }
    var dL = 0, dR = 0, dT = 0, dB = 0
    for d in 4...64 where vline(x0 - d) { dL = d; break }
    for d in 4...64 where vline(x1 + d) { dR = d; break }
    for d in 4...44 where hline(y0 - d) { dT = d; break }
    for d in 4...44 where hline(y1 + d) { dB = d; break }
    if dB == 0 && dT > 0 && dT <= 44 { var d = 45; while d < 230 { if hline(y1 + d) { dB = d; break }; d += 1 } }
    // botão preenchido de largura total: o texto fica longe das bordas laterais, mas centralizado
    if dT > 0 && dB > 0 && (dL == 0 || dR == 0) {
        var wl = dL, wr = dR
        if wl == 0 { var k = 65; while k < 1500 { if vline(x0 - k) { wl = k; break }; k += 1 } }
        if wr == 0 { var k = 65; while k < 1500 { if vline(x1 + k) { wr = k; break }; k += 1 } }
        if wl > 0 && wr > 0 {
            let q = Double(wl) / Double(wr), foraE = b.at(max(0, x0 - wl - 4), my), foraD = b.at(min(b.w - 1, x1 + wr + 4), my)
            if q >= 0.7 && q <= 1.4 && cdist(inner, foraE) >= 60 && cdist(inner, foraD) >= 60 && cdist(inner, (255, 255, 255)) >= 60 { dL = wl; dR = wr }
        }
    }
    guard dL > 0, dT > 0, dB > 0 else { return nil }
    // borda de container (card/menu) continua além do retângulo; borda de botão/campo termina nos cantos
    let bx = x0 - dL, by0 = y0 - dT, by1 = y1 + dB
    if bx - 1 >= 0, by0 - 8 >= 0, by1 + 8 < b.h {
        let edge = b.at(bx, (by0 + by1) / 2)
        let outside = b.at(max(0, bx - 4), (by0 + by1) / 2)
        func continua(_ yy: Int) -> Bool { for o in -2...2 where bx + o >= 0 { if cdist(b.at(bx + o, yy), edge) < 14 { return true } }; return false }
        if cdist(edge, outside) >= 20 && continua(by0 - 8) && continua(by1 + 8) { return nil }
    }
    var rightOpen = false
    if dR == 0 {                           // campo de texto: borda direita longe
        var d = 65; while d < 1500 { if vline(x1 + d) { dR = d; break }; d += 1 }
        if dR == 0 { return nil }
        rightOpen = true
        // botão preenchido de largura total: texto centralizado e preenchimento bem diferente do entorno
        let q = Double(dL) / Double(dR), fora = b.at(max(0, x0 - dL - 4), my)
        if q >= 0.7 && q <= 1.4 && cdist(inner, fora) >= 60 && cdist(inner, (255, 255, 255)) >= 60 { rightOpen = false }
    } else {
        let ratio = Double(dL) / Double(dR)
        if ratio < 0.4 || ratio > 2.5 { return nil }
    }
    let box = CGRect(x: x0 - dL, y: y0 - dT, width: (x1 + dR) - (x0 - dL) + 1, height: (y1 + dB) - (y0 - dT) + 1)
    if rightOpen {   // campo: as quatro bordas precisam existir ao longo de todo o retângulo
        func frac(_ pts: [(Int, Int)]) -> Double { Double(pts.filter { cdist(b.at($0.0, $0.1), inner) > T }.count) / Double(max(pts.count, 1)) }
        let bx0 = Int(box.minX), bx1 = Int(box.maxX) - 1, by0 = Int(box.minY), by1 = Int(box.maxY) - 1
        guard bx1 < b.w, by1 < b.h, bx1 - bx0 > 40, by1 - by0 > 20 else { return nil }
        let top = stride(from: bx0 + 12, to: bx1 - 12, by: 2).map { ($0, by0) }, bot = stride(from: bx0 + 12, to: bx1 - 12, by: 2).map { ($0, by1) }
        let lef = stride(from: by0 + 12, to: by1 - 12, by: 2).map { (bx0, $0) }, rig = stride(from: by0 + 12, to: by1 - 12, by: 2).map { (bx1, $0) }
        if frac(top) < 0.97 || frac(bot) < 0.97 || frac(lef) < 0.85 || frac(rig) < 0.85 { return nil }
    }
    return (box, rightOpen)
}

func isBlueText(_ b: Bmp, _ r: CGRect) -> Bool {
    let x0 = max(0, Int(r.minX)), x1 = min(b.w - 1, Int(r.maxX)), y0 = max(0, Int(r.minY)), y1 = min(b.h - 1, Int(r.maxY))
    guard x1 > x0, y1 > y0, x0 - 4 >= 0 else { return false }
    let bg = b.at(x0 - 4, (y0 + y1) / 2)
    var best = 0; var bc = bg
    for y in stride(from: y0, through: y1, by: 1) { for x in stride(from: x0, through: x1, by: 1) {
        let c = b.at(x, y); let d = cdist(c, bg); if d > best { best = d; bc = c } } }
    return best > 120 && bc.2 > bc.0 + 50 && bc.2 > bc.1 + 15
}

func analyze(_ cap: PageCap) -> [Elem] {
    let b = Bmp(cap.page)
    let segs = ocrSegments(cap.page)
    var els = [Elem]()
    for s in segs {
        var e = Elem(); e.text = s.text; e.r = s.r; e.conf = s.conf; e.kind = "texto"
        if s.text == "◯" { e.kind = "marcavel"; els.append(e); continue }
        if let en = enclose(b, s.r) {
            let hpt = en.rect.height / 2
            if en.rightOpen {
                if en.rect.minX < 12 { e.kind = "item"; e.r = en.rect }                     // item ativo do menu lateral
                else if hpt >= 24 && hpt <= 140 {
                    let t = s.text
                    e.kind = (t.hasPrefix("•") || t.hasPrefix("▸") || t.hasPrefix("▶") || t.hasPrefix("►")) ? "acordeao" : "campo"
                    e.r = en.rect
                }
            }
            else if hpt >= 24 && hpt <= 70 { e.kind = "botao"; e.r = en.rect }
            else if hpt < 24 { e.kind = "etiqueta"; e.r = en.rect }
        } else if isBlueText(b, s.r) { e.kind = "link" }
        els.append(e)
    }
    // descarta caixas que contêm o centro de outros textos (são containers, não botões/campos)
    for i in els.indices where ["botao", "campo", "etiqueta", "acordeao", "item"].contains(els[i].kind) {
        for j in els.indices where j != i && segs[j].text != "◯" {
            let c = CGPoint(x: segs[j].r.midX, y: segs[j].r.midY)
            if els[i].r.contains(c) && !els[i].r.contains(CGPoint(x: segs[i].r.midX, y: segs[i].r.midY).applying(.identity)) == false && els[i].r.contains(c) {
                els[i].kind = "texto"; els[i].r = segs[i].r; break
            }
        }
    }
    // marcador dentro de uma caixa larga = seta de acordeão; fora de caixa = checkbox/rádio
    for mi in els.indices where els[mi].kind == "marcavel" {
        let c = CGPoint(x: els[mi].r.midX, y: els[mi].r.midY)
        if let ci = els.indices.first(where: { els[$0].kind == "campo" && els[$0].r.contains(c) }) { els[ci].kind = "acordeao"; els[mi].kind = "descartar" }
    }
    els.removeAll { $0.kind == "descartar" }
    let novos = detectEmptyFields(b, els)
    els.removeAll { t in t.kind == "texto" && novos.contains { $0.r.contains(CGPoint(x: t.r.midX, y: t.r.midY)) } }
    els += novos
    let extras = detectMarcaveis(b, els).filter { m in !els.contains { $0.kind == "marcavel" && $0.r.intersects(m.r.insetBy(dx: -8, dy: -8)) } }
    els += extras
    associateLabels(&els)
    // elementos fixos (topbar/sidebar): iguais no frame0 e frame1
    if let f1 = cap.frame1 {
        let b0 = Bmp(cap.frame0), b1 = Bmp(f1)
        let top = Int(contentTopPt * 2)
        for i in els.indices {
            let r = els[i].r
            let y = Int(r.minY) + top
            if y + Int(r.height) < b0.h {
                let bb = CGRect(x: Int(r.minX), y: y, width: Int(r.width), height: Int(r.height))
                var diff = 0, tot = 0
                var yy = Int(bb.minY); while yy < Int(bb.maxY) { var xx = Int(bb.minX); while xx < Int(bb.maxX) { tot += 1
                    if cdist(b0.at(xx, yy), b1.at(xx, yy)) > 40 { diff += 1 }; xx += 2 }; yy += 2 }
                els[i].fixed = tot > 0 && Double(diff) / Double(tot) < 0.01
            }
        }
    }
    els.sort { (Int($0.r.minY / 40), $0.r.minX) < (Int($1.r.minY / 40), $1.r.minX) }
    for i in els.indices { els[i].id = i + 1 }
    return els
}


// MARK: - Campos vazios, rótulos e tipos
func inferTipo(_ label: String, _ text: String, _ hpt: CGFloat) -> String {
    let s = (label + " " + text).lowercased()
    func has(_ k: [String]) -> Bool { k.contains { s.contains($0) } }
    if has(["busca", "pesquis", "search", "buscar"]) { return "busca" }
    if has(["e-mail", "email"]) { return "email" }
    if has(["telefone", "celular", "whatsapp"]) { return "telefone" }
    if has(["cpf"]) { return "cpf" }
    if has(["cep"]) { return "cep" }
    if has(["senha", "password"]) { return "senha" }
    if has(["selecione", "país", "pais", "estado", "plano", "idiomas"]) { return "selecao" }
    if has(["data e hora", "reunião"]) { return "datahora" }
    if has(["mês", "mes de"]) { return "mes" }
    if has(["semana"]) { return "semana" }
    if has(["horário", "hora", "--:--"]) { return "hora" }
    if has(["dd/mm", "nascimento", "data"]) { return "data" }
    if has(["r$", "salári", "salari", "valor"]) { return "dinheiro" }
    if has(["site", "url", "http"]) { return "url" }
    if has(["número", "numero", "quantidade"]) { return "numero" }
    if hpt > 60 { return "textolongo" }
    if has(["usuário", "usuario", "login"]) { return "usuario" }
    if has(["nome"]) { return "nome" }
    return "texto"
}
// (valor válido, texto esperado na tela, valor inválido ou nil)
func amostra(_ t: String) -> (String, String, String?) {
    switch t {
    case "email": return ("teste.qa@exemplo.com", "teste.qa@exemplo.com", "abc")
    case "telefone": return ("11912345678", "(11) 91234-5678", "123")
    case "cpf": return ("52998224725", "529.982.247-25", "11111111111")
    case "cep": return ("01310100", "01310-100", "123")
    case "dinheiro": return ("150000", "R$ 1.500,00", nil)
    case "senha": return ("Senha1234", "•", "123")
    case "data": return ("20051990", "20/05/1990", nil)
    case "hora": return ("1430", "14:30", nil)
    case "numero": return ("12", "12", nil)
    case "url": return ("https://exemplo.com", "https://exemplo.com", "abc")
    case "usuario": return ("maria_silva", "maria_silva", "A!")
    case "busca": return ("teste", "teste", nil)
    case "textolongo": return ("Texto de teste automatizado", "Texto de teste", nil)
    case "nome": return ("Maria da Silva", "Maria da Silva", "a")
    default: return ("Teste QA", "Teste QA", nil)
    }
}
let tiposDigitaveis: Set<String> = ["email", "telefone", "cpf", "cep", "senha", "data", "hora", "dinheiro", "url", "numero", "usuario", "busca", "textolongo", "nome", "texto"]

func detectEmptyFields(_ b: Bmp, _ els: [Elem]) -> [Elem] {
    var out = [Elem]()
    let T = 28
    for el in els where el.kind == "texto" && el.r.height < 44 && el.text.count >= 2 && el.text.count <= 45 {
        let lx = Int(el.r.minX), ly1 = Int(el.r.maxY)
        guard lx - 8 >= 0, lx + 400 < b.w, ly1 + 260 < b.h else { continue }
        // já existe caixa logo abaixo deste rótulo?
        if els.contains(where: { ["campo", "botao", "acordeao"].contains($0.kind) && $0.r.minY > el.r.maxY - 4 && $0.r.minY - el.r.maxY < 70 && $0.r.minX < el.r.maxX + 60 && $0.r.maxX > el.r.minX }) { continue }
        let bg = b.at(lx - 4, (Int(el.r.minY) + ly1) / 2)
        func hl(_ y: Int, _ x0: Int, _ x1: Int) -> Bool { var n = 0, t = 0; var x = x0; while x < x1 { t += 1; if cdist(b.at(x, y), bg) > T { n += 1 }; x += 2 }; return Double(n) / Double(max(t, 1)) >= 0.9 }
        func vl(_ x: Int, _ y0: Int, _ y1: Int) -> Bool { var n = 0, t = 0; var y = y0; while y < y1 { t += 1; if cdist(b.at(x, y), bg) > T { n += 1 }; y += 2 }; return Double(n) / Double(max(t, 1)) >= 0.9 }
        var top = 0
        for y in (ly1 + 4)...(ly1 + 60) where hl(y, lx + 14, lx + 90) { top = y; break }
        if top == 0 { continue }
        var bot = 0
        for y in (top + 40)...min(b.h - 2, top + 220) where hl(y, lx + 14, lx + 90) { bot = y; break }
        if bot == 0 { continue }
        // interior com pouco conteúdo (vazio ou só placeholder/ícone)
        let inner = b.at(lx + 12, (top + bot) / 2)
        var bad = 0, tot = 0
        var yy = top + 14; while yy < bot - 14 { var xx = lx + 14; while xx < lx + 700 && xx < b.w - 2 { tot += 1; if cdist(b.at(xx, yy), inner) > 30 { bad += 1 }; xx += 3 }; yy += 3 }
        if tot == 0 || Double(bad) / Double(tot) > 0.12 { continue }
        var left = -1
        for x in max(0, lx - 8)...(lx + 6) where vl(x, top + 12, bot - 12) { left = x; break }
        if left < 0 { continue }
        var right = -1
        var x = lx + 120; while x < min(b.w - 2, lx + 1500) { if vl(x, top + 12, bot - 12) { right = x; break }; x += 1 }
        if right < 0 { continue }
        let r = CGRect(x: left, y: top, width: right - left + 1, height: bot - top + 1)
        let hpt = r.height / 2
        if r.width < 120 || hpt < 22 || hpt > 140 { continue }
        if els.contains(where: { $0.kind != "texto" && $0.r.intersects(r) }) { continue }
        let dentro = els.filter { $0.kind == "texto" && $0.r.midY > r.minY && $0.r.midY < r.maxY && $0.r.midX > r.minX && $0.r.midX < r.maxX }
        if dentro.count > 3 { continue }
        var e = Elem(); e.kind = "campo"; e.text = dentro.map { $0.text }.joined(separator: " "); e.r = r; e.conf = 1
        out.append(e)
    }
    return out
}


// checkbox / radio: pequeno contorno quadrado ou redondo logo à esquerda de um texto
func detectMarcaveis(_ b: Bmp, _ els: [Elem]) -> [Elem] {
    var out = [Elem]()
    for el in els where el.kind == "texto" && el.r.height < 44 && el.text.count >= 2 {
        let mid = Int((el.r.minY + el.r.maxY) / 2), tx = Int(el.r.minX)
        guard tx - 52 >= 0, mid - 22 >= 0, mid + 22 < b.h, tx - 2 < b.w else { continue }
        let bg = b.at(tx - 3, mid)
        // colunas (da direita p/ esquerda) com pixels diferentes do fundo
        var cols = [Bool]()
        for x in stride(from: tx - 3, through: tx - 52, by: -1) {
            var n = 0; for y in (mid - 22)...(mid + 22) where cdist(b.at(x, y), bg) > 30 { n += 1 }
            cols.append(n > 0)
        }
        // primeira corrida de colunas ocupadas, depois de um respiro
        var i = 0
        while i < cols.count && !cols[i] { i += 1 }
        let startI = i
        while i < cols.count && cols[i] { i += 1 }
        let runW = i - startI
        if startI > 14 || runW < 20 || runW > 44 { continue }
        let xr = tx - 3 - startI, xl = tx - 3 - (i - 1)
        // altura do contorno
        var y0 = Int.max, y1 = -1
        for y in (mid - 22)...(mid + 22) { for x in xl...xr where cdist(b.at(x, y), bg) > 30 { if y < y0 { y0 = y }; if y > y1 { y1 = y }; break } }
        let h = y1 - y0 + 1
        if h < 20 || h > 44 || abs(h - runW) > 8 { continue }
        // contorno vazado (o interior é quase só fundo) — descarta letras/ícones preenchidos
        var dens = 0, tot = 0
        for y in y0...y1 { for x in xl...xr { tot += 1; if cdist(b.at(x, y), bg) > 30 { dens += 1 } } }
        let d = Double(dens) / Double(max(tot, 1))
        if d < 0.08 || d > 0.75 { continue }
        var e = Elem(); e.kind = "marcavel"; e.text = el.text; e.label = el.text; e.conf = 1
        e.r = CGRect(x: xl, y: y0, width: runW, height: h)
        out.append(e)
    }
    return out
}

func associateLabels(_ els: inout [Elem]) {
    for i in els.indices where els[i].kind == "marcavel" && els[i].text == "◯" {
        let r = els[i].r
        let cand = els.indices.filter { els[$0].kind == "texto" && els[$0].r.minX >= r.maxX - 4 && els[$0].r.minX - r.maxX < 60 && abs(els[$0].r.midY - r.midY) < r.height }
        if let j = cand.min(by: { els[$0].r.minX < els[$1].r.minX }) { els[i].text = els[j].text; els[i].label = els[j].text; els[i].req = els[j].text.contains("*") }
        else { els[i].text = "(opção)"; els[i].label = "(opção)" }
    }
    for i in els.indices where els[i].kind == "campo" {
        let r = els[i].r
        var best: Int? = nil; var bestD = CGFloat.greatestFiniteMagnitude
        for j in els.indices where j != i && els[j].kind == "texto" {
            let t = els[j].r
            let dy = r.minY - t.maxY
            if dy < -4 || dy > 64 { continue }
            if t.minX > r.maxX || t.maxX < r.minX { continue }
            if abs(t.minX - r.minX) > 90 { continue }
            if dy < bestD { bestD = dy; best = j }
        }
        var label = ""
        if let j = best { label = els[j].text }
        // rótulo escrito dentro do campo (placeholder) ou à esquerda não é considerado
        let req = label.contains("*")
        label = label.replacingOccurrences(of: "*", with: "").trimmingCharacters(in: .whitespaces)
        for (a, b) in [("С", "C"), ("Е", "E"), ("О", "O"), ("Р", "P"), ("А", "A"), ("Т", "T"), ("Х", "X"), ("Н", "H"), ("М", "M"), ("К", "K"), ("В", "B"), ("І", "I"), ("с", "c"), ("е", "e"), ("о", "o"), ("р", "p"), ("а", "a"), ("х", "x")] { label = label.replacingOccurrences(of: a, with: b) }
        els[i].label = label; els[i].req = req
        els[i].tipo = inferTipo(label, els[i].text, r.height / 2)
    }
}

// MARK: - Visibilidade / posição de clique
func viewportPoint(_ e: Elem) -> CGPoint {       // centro em coords da janela (pt)
    let cx = e.r.midX / 2
    let cy = e.r.midY / 2
    if e.fixed { return CGPoint(x: cx, y: contentTopPt + cy) }
    return CGPoint(x: cx, y: contentTopPt + cy - CGFloat(curYpx) / 2)
}
func ensureVisible(_ e: Elem) -> CGPoint {
    if e.fixed { if curYpx != 0 && false { gotoScroll(0) }; return viewportPoint(e) }
    let viewHpt = G.frame.height - contentTopPt
    let yv = e.r.midY / 2 - CGFloat(curYpx) / 2
    if yv < 40 || yv > viewHpt - 40 {
        gotoScroll(max(0, Int(e.r.midY - CGFloat(viewHpt) * 2 * 0.4)))
    }
    return viewportPoint(e)
}

// MARK: - Anotação (malha + caixas)
func annotate(_ cap: PageCap, _ els: [Elem]) -> CGImage {
    let W = cap.page.width, H = cap.page.height
    let ctx = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    ctx.draw(cap.page, in: CGRect(x: 0, y: 0, width: W, height: H))
    func Y(_ y: CGFloat) -> CGFloat { CGFloat(H) - y }
    // malha: linhas finas a cada 50 pt, fortes a cada 100 pt
    var gx = 0
    while gx * 2 < W {
        let strong = gx % 100 == 0
        ctx.setStrokeColor(CGColor(red: 0, green: 0.7, blue: 1, alpha: strong ? 0.45 : 0.16))
        ctx.setLineWidth(strong ? 2 : 1)
        ctx.move(to: CGPoint(x: gx * 2, y: 0)); ctx.addLine(to: CGPoint(x: gx * 2, y: H)); ctx.strokePath()
        gx += 50
    }
    var gy = 0
    while gy * 2 < H {
        let strong = gy % 100 == 0
        ctx.setStrokeColor(CGColor(red: 0, green: 0.7, blue: 1, alpha: strong ? 0.45 : 0.16))
        ctx.setLineWidth(strong ? 2 : 1)
        ctx.move(to: CGPoint(x: 0, y: Y(CGFloat(gy * 2)))); ctx.addLine(to: CGPoint(x: CGFloat(W), y: Y(CGFloat(gy * 2)))); ctx.strokePath()
        gy += 50
    }
    // caixas
    for e in els {
        let color: CGColor
        switch e.kind {
        case "botao": color = CGColor(red: 1, green: 0.1, blue: 0.2, alpha: 1)
        case "campo": color = CGColor(red: 1, green: 0.55, blue: 0, alpha: 1)
        case "link", "menu": color = CGColor(red: 0.2, green: 0.4, blue: 1, alpha: 1)
        case "marcavel": color = CGColor(red: 0.1, green: 0.6, blue: 0.9, alpha: 1)
        case "etiqueta": color = CGColor(red: 0.7, green: 0.3, blue: 0.9, alpha: 1)
        default: color = CGColor(red: 0.1, green: 0.7, blue: 0.3, alpha: 1)
        }
        ctx.setStrokeColor(color); ctx.setLineWidth(e.kind == "texto" ? 1.5 : 3)
        ctx.stroke(CGRect(x: e.r.minX, y: Y(e.r.maxY), width: e.r.width, height: e.r.height))
    }
    let gc = NSGraphicsContext(cgContext: ctx, flipped: false)
    NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = gc
    func label(_ s: String, _ x: CGFloat, _ y: CGFloat, fg: NSColor, bg: NSColor, size: CGFloat = 16) {
        let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.boldSystemFont(ofSize: size), .foregroundColor: fg]
        let str = NSAttributedString(string: s, attributes: attrs)
        let sz = str.size()
        bg.setFill(); NSBezierPath(rect: NSRect(x: x, y: Y(y) - sz.height, width: sz.width + 6, height: sz.height)).fill()
        str.draw(at: NSPoint(x: x + 3, y: Y(y) - sz.height))
    }
    var ax = 0
    while ax * 2 < W { label("x\(ax)", CGFloat(ax * 2) + 2, 2, fg: .white, bg: NSColor(red: 0, green: 0.45, blue: 0.7, alpha: 0.9), size: 15); ax += 100 }
    var ay = 100
    while ay * 2 < H { label("y\(ay)", 2, CGFloat(ay * 2) + 2, fg: .white, bg: NSColor(red: 0, green: 0.45, blue: 0.7, alpha: 0.9), size: 15); ay += 100 }
    var ix = 200
    while ix * 2 < W { var iy = 200; while iy * 2 < H {
        label("\(ix),\(iy)", CGFloat(ix * 2) + 2, CGFloat(iy * 2) + 2, fg: NSColor(red: 0, green: 0.35, blue: 0.55, alpha: 1), bg: NSColor(white: 1, alpha: 0.7), size: 12); iy += 200 }; ix += 200 }
    for e in els where e.kind != "texto" || true {
        let tag = e.kind == "texto" ? "\(e.id)" : "#\(e.id)"
        let bgc: NSColor = e.kind == "botao" ? NSColor(red: 1, green: 0.1, blue: 0.2, alpha: 0.95)
            : e.kind == "texto" ? NSColor(red: 0.1, green: 0.6, blue: 0.3, alpha: 0.9) : NSColor(red: 0.2, green: 0.4, blue: 1, alpha: 0.95)
        label(tag, e.r.minX, max(0, e.r.minY - 18), fg: .white, bg: bgc, size: e.kind == "texto" ? 11 : 14)
    }
    NSGraphicsContext.restoreGraphicsState()
    return ctx.makeImage()!
}

// MARK: - JSON helpers
func elemDict(_ e: Elem) -> [String: Any] {
    let cx = e.r.midX / 2, cy = e.r.midY / 2
    return ["id": e.id, "kind": e.kind, "text": e.text,
            "x": Int(e.r.minX / 2), "y": Int(e.r.minY / 2), "w": Int(e.r.width / 2), "h": Int(e.r.height / 2),
            "cx": Int(cx), "cy": Int(cy), "fixed": e.fixed, "hover": e.hover, "conf": Double(e.conf),
            "rotulo": e.label, "tipo": e.tipo, "obrigatorio": e.req]
}
func writeJSON(_ obj: Any, _ path: String) {
    if let d = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]) { try? d.write(to: URL(fileURLWithPath: path)) }
}

// MARK: - Hover (descobre itens interativos sem caixa, ex.: menu lateral)
func probeHover(_ els: inout [Elem]) {
    let neutral = CGPoint(x: 600, y: 12)
    for i in els.indices where els[i].kind == "texto" && els[i].text.count <= 40 && els[i].text.count >= 3 {
        if !els[i].fixed && Int(els[i].r.minY) > 900 * 2 { continue }
        let p = ensureVisible(els[i])
        moveTo(neutral); usleep(30000)
        guard let a = waitStable(minMs: 20, maxMs: 200) else { continue }
        moveTo(p); usleep(30000)
        guard let b = waitStable(minMs: 40, maxMs: 250) else { continue }
        let A = Bmp(a), B = Bmp(b)
        let r = els[i].r
        let x0 = max(0, Int(r.minX) - 40), x1 = min(A.w, Int(r.maxX) + 600)
        let yv = Int(contentTopPt * 2) + Int(r.midY) - (els[i].fixed ? 0 : curYpx)
        let y0 = max(0, yv - 30), y1 = min(A.h, yv + 30)
        var n = 0, t = 0
        var y = y0; while y < y1 { var x = x0; while x < x1 { t += 1; if cdist(A.at(x, y), B.at(x, y)) > 18 { n += 1 }; x += 3 }; y += 3 }
        if t > 0 && Double(n) / Double(t) > 0.06 { els[i].hover = true; els[i].kind = "item" }
    }
    moveTo(neutral)
}

// MARK: - Execução do teste de botões
struct StepRes {
    var elem: Elem; var time = ""; var reactMs = 0; var restoreMs = 0; var totalMs = 0
    var contentChange = 0.0; var chromeChange = 0.0; var navigated = false
    var clickPt = CGPoint.zero; var verdict = ""; var restored = true; var restoreMethod = ""; var notes: [String] = []
    var beforeFile = ""; var afterFile = ""; var skipped = false
}

func matchBase(_ base: Bmp, maxMs: Int) -> Bool {
    let t = Date(); let top = Int(contentTopPt * 2)
    while msSince(t) < maxMs {
        if let f = capture() { let b = Bmp(f); if diffInfo(base, b, y0: top, y1: b.h).ratio < 0.004 { return true } }
        usleep(25000)
    }
    return false
}

func runTests(_ els: [Elem], budgetMs: Int, outdir: String) -> [StepRes] {
    let top = Int(contentTopPt * 2)
    let t0 = Date()
    var results = [StepRes]()
    _ = scrollToTop(); curYpx = 0
    let targets = els.filter { ["botao", "item", "link", "acordeao"].contains($0.kind) }
    var n = 0
    for e in targets {
        n += 1
        var r = StepRes(elem: e); r.time = nowStamp()
        if msSince(t0) > budgetMs { r.skipped = true; r.verdict = "nao_testado"; r.notes.append("orçamento de tempo esgotado"); results.append(r); continue }
        let ts = Date()
        let p = ensureVisible(e)
        guard let before = waitStable(minMs: 20, maxMs: 300) else { continue }
        let bB = Bmp(before)
        r.clickPt = p
        let c0 = Date()
        clickAt(p)
        var after = before; var afterB = bB; var lastB = bB
        while msSince(c0) < 700 {
            usleep(25000)
            guard let f = capture() else { continue }
            let fb = Bmp(f)
            let dLast = diffInfo(lastB, fb, y0: 0, y1: fb.h).ratio
            let dBase = diffInfo(bB, fb, y0: top, y1: fb.h).ratio
            after = f; afterB = fb
            if dLast < 0.0003 && msSince(c0) >= 70 && (dBase > 0.0005 || msSince(c0) >= 200) { break }
            lastB = fb
        }
        r.reactMs = msSince(c0)
        let content = diffInfo(bB, afterB, y0: top, y1: afterB.h)
        let chrome = diffInfo(bB, afterB, y0: 0, y1: top)
        r.contentChange = content.ratio; r.chromeChange = chrome.ratio
        r.navigated = chrome.ratio > 0.0008 && content.ratio > 0.2
        let changed = content.ratio > 0.0004 || chrome.ratio > 0.0008
        let id = String(format: "%02d", n)
        r.beforeFile = "step\(id)_antes.jpg"; r.afterFile = "step\(id)_depois.jpg"
        saveImage(before, "\(outdir)/\(r.beforeFile)", jpeg: true, maxW: 1100)
        saveImage(after, "\(outdir)/\(r.afterFile)", jpeg: true, maxW: 1100)
        if !changed { r.verdict = "sem_reacao" }
        else if r.navigated { r.verdict = "navegou" }
        else { r.verdict = "reagiu" }
        // volta ao estado anterior
        let rs = Date()
        if changed {
            if r.navigated { backKey(); r.restoreMethod = "voltar (Cmd+[)" } else { reloadKey(); r.restoreMethod = "recarregar (Cmd+R)" }
            var ok = matchBase(bB, maxMs: 900)
            if !ok && r.navigated { reloadKey(); ok = matchBase(bB, maxMs: 700); r.restoreMethod += " + recarregar" }
            if !ok {
                r.restored = false; r.notes.append("a tela não voltou ao estado anterior após \(r.restoreMethod)")
                let o = scrollToTop(); _ = o; curYpx = 0
            }
        }
        r.restoreMs = msSince(rs)
        r.totalMs = msSince(ts)
        results.append(r)
    }
    return results
}


// MARK: - Modo offline: análise de imagens (sem janela). Coordenadas em pontos (= px CSS quando devicePixelRatio = 2)
func runOffline(_ a: [String]) {
    func load(_ p: String) -> CGImage { guard let i = CGImage.fromFile(p) else { fail("não abriu \(p)") }; return i }
    switch a[1] {
    case "analisar":   // analisar full.png outdir [viewport0.png viewportRolado.png]
        guard a.count >= 4 else { fail("uso: analisar full.png outdir [v0 v1]") }
        let t0 = Date()
        let img = load(a[2]); let out = a[3]
        try? FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
        let v0 = a.count > 4 ? load(a[4]) : nil, v1 = a.count > 5 ? load(a[5]) : nil
        contentTopPt = 0
        let cap = PageCap(page: img, chrome: img, frame0: v0 ?? img, frame1: v1, totalPx: 0, viewHpx: v0?.height ?? img.height, originalYpx: 0)
        let els = analyze(cap)
        let tA = msSince(t0)
        if ProcessInfo.processInfo.environment["FX_SEM_MALHA"] == nil { saveImage(annotate(cap, els), "\(out)/pagina_malha.jpg", jpeg: true, maxW: 1600) }
        writeJSON(["paginaW": img.width / 2, "paginaH": img.height / 2, "analiseMs": tA, "hora": nowStamp(), "elementos": els.map(elemDict)] as [String: Any], "\(out)/resultado.json")
        print("ok \(tA)ms")
    case "ocr":        // ocr [--rapido] a.png b.png ...  -> JSON {arquivo: [{text,x,y,w,h}]}
        var files = Array(a.dropFirst(2)); var fast = false
        if files.first == "--rapido" { fast = true; files.removeFirst() }
        _ = fast
        var res = [String: Any]()
        for f in files {
            let segs = ocrSegments(load(f))
            res[f] = segs.map { ["text": $0.text, "x": Int($0.r.minX / 2), "y": Int($0.r.minY / 2), "w": Int($0.r.width / 2), "h": Int($0.r.height / 2)] as [String: Any] }
        }
        if let d = try? JSONSerialization.data(withJSONObject: res), let s = String(data: d, encoding: .utf8) { print(s) }
    case "comparar":   // comparar a1 b1 a2 b2 ... -> [{ratio,bbox}]
        var out = [[String: Any]]()
        var i = 2
        while i + 1 < a.count {
            let A = Bmp(load(a[i])), B = Bmp(load(a[i + 1]))
            let d = diffInfo(A, B, y0: 0, y1: A.h, step: 2, thr: 40)
            var o: [String: Any] = ["ratio": d.ratio]
            if let b = d.bbox { o["bbox"] = [Int(b.minX / 2), Int(b.minY / 2), Int(b.width / 2), Int(b.height / 2)] }
            out.append(o); i += 2
        }
        if let d = try? JSONSerialization.data(withJSONObject: out), let s = String(data: d, encoding: .utf8) { print(s) }
    case "difreg":     // difreg a.png b.png x y w h [x y w h ...] -> [ratio...] (região em pontos)
        let A = Bmp(load(a[2])), B = Bmp(load(a[3]))
        var out = [Double](); var i = 4
        while i + 3 < a.count {
            let x0 = max(0, (Int(a[i]) ?? 0) * 2), y0 = max(0, (Int(a[i + 1]) ?? 0) * 2)
            let x1 = min(A.w, x0 + (Int(a[i + 2]) ?? 0) * 2), y1 = min(A.h, y0 + (Int(a[i + 3]) ?? 0) * 2)
            var n = 0, t = 0
            if A.w == B.w && A.h == B.h { var y = y0; while y < y1 { var x = x0; while x < x1 { t += 1; if cdist(A.at(x, y), B.at(x, y)) > 40 { n += 1 }; x += 2 }; y += 2 } }
            out.append(t == 0 ? 0 : Double(n) / Double(t)); i += 4
        }
        if let d = try? JSONSerialization.data(withJSONObject: out), let str = String(data: d, encoding: .utf8) { print(str) }
    case "miniaturas": // miniaturas largura in1 out1 in2 out2 ...
        let w = Int(a[2]) ?? 480
        var i = 3
        while i + 1 < a.count { saveImage(load(a[i]), a[i + 1], jpeg: true, maxW: w); i += 2 }
        print("ok")
    default: fail("comando offline desconhecido")
    }
}
if CommandLine.arguments.count >= 2 && ["analisar", "ocr", "comparar", "miniaturas", "difreg"].contains(CommandLine.arguments[1]) { runOffline(CommandLine.arguments); exit(0) }

// MARK: - Comandos
let args = CommandLine.arguments
guard args.count >= 2 else { fail("uso: fxctl shot|click|key|run ...") }
guard let w = findFirefox() else { fail("janela do Firefox não encontrada") }
G = w
let frontBefore = NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "?"

switch args[1] {
case "shot", "run":
    guard args.count >= 3 else { fail("falta outdir") }
    let outdir = args[2]
    try? FileManager.default.createDirectory(atPath: outdir, withIntermediateDirectories: true)
    let isRun = args[1] == "run"
    let budget = isRun && args.count > 3 ? (Int(args[3]) ?? 8000) : 0
    let ctIdx = isRun ? 4 : 3
    if args.count > ctIdx, let v = Double(args[ctIdx]) { contentTopPt = CGFloat(v) }
    let doHover = isRun && args.count > 5 ? args[5] == "1" : false
    let tStart = Date()
    guard let cap = capturePage() else { fail("falha na captura") }
    var els = analyze(cap)
    let tAnalyze = msSince(tStart)
    if doHover { probeHover(&els); gotoScroll(0) }
    saveImage(cap.page, "\(outdir)/pagina.png")
    saveImage(annotate(cap, els), "\(outdir)/pagina_malha.png")
    saveImage(annotate(cap, els), "\(outdir)/pagina_malha.jpg", jpeg: true, maxW: 1600)
    saveImage(cap.chrome, "\(outdir)/chrome.png")
    var summary: [String: Any] = [
        "janela": ["x": Int(G.frame.minX), "y": Int(G.frame.minY), "w": Int(G.frame.width), "h": Int(G.frame.height)],
        "topoConteudoPt": Int(contentTopPt),
        "paginaW": cap.page.width / 2, "paginaH": cap.page.height / 2,
        "rolavel": cap.totalPx > 0, "scrollTotalPt": cap.totalPx / 2, "scrollOriginalPt": cap.originalYpx / 2,
        "capturaMs": tAnalyze, "hora": nowStamp(),
        "elementos": els.map(elemDict)
    ]
    if isRun {
        if !doHover { gotoScroll(0) }
        let useFG = args.count > 6 && args[6] == "fg"
        let prevApp = NSWorkspace.shared.frontmostApplication
        if useFG { NSRunningApplication(processIdentifier: G.pid)?.activate(options: [.activateIgnoringOtherApps]); usleep(250000) }
        let tTest = Date()
        let steps = runTests(els, budgetMs: budget, outdir: outdir)
        if useFG { prevApp?.activate(options: [.activateIgnoringOtherApps]) }
        summary["modoClique"] = useFG ? "primeiro plano (foco devolvido ao final)" : "segundo plano"
        let testMs = msSince(tTest)
        // OCR pós-teste (fora do cronômetro): URL e textos novos
        let known = Set(els.map { $0.text.lowercased() })
        var stepDicts = [[String: Any]]()
        for var s in steps {
            var newTexts = [String](); var url = ""
            if !s.skipped && s.verdict != "sem_reacao", let img = CGImage.fromFile("\(outdir)/\(s.afterFile)") {
                let segs = ocrSegments(img)
                for g in segs where !known.contains(g.text.lowercased()) && g.text.count > 2 { newTexts.append(g.text) }
                if let ch = img.cropping(to: CGRect(x: 0, y: 0, width: img.width, height: Int(contentTopPt * Double(img.width) / Double(G.frame.width)))) {
                    for g in ocrSegments(ch) where g.text.contains("/") || g.text.contains("://") { url = g.text }
                }
            }
            let low = newTexts.joined(separator: " ").lowercased()
            if ["404", "not found", "erro", "error", "não foi possível", "unable to connect", "server not found", "problema ao carregar"].contains(where: { low.contains($0) }) {
                s.notes.append("a tela após o clique parece conter uma mensagem de erro")
            }
            if s.reactMs > 1000 { s.notes.append("resposta lenta (\(s.reactMs) ms até a tela estabilizar)") }
            var d: [String: Any] = [
                "elemento": elemDict(s.elem), "hora": s.time, "reagiuEmMs": s.reactMs, "restauroMs": s.restoreMs, "totalMs": s.totalMs,
                "mudancaConteudo": s.contentChange, "mudancaBarra": s.chromeChange, "navegou": s.navigated,
                "veredito": s.verdict, "restaurou": s.restored, "metodoRestauro": s.restoreMethod, "notas": s.notes,
                "cliqueEm": ["x": Int(s.clickPt.x), "y": Int(s.clickPt.y)], "antes": s.beforeFile, "depois": s.afterFile, "textosNovos": Array(newTexts.prefix(25)), "urlDepois": url, "pulado": s.skipped
            ]
            if s.skipped { d["antes"] = ""; d["depois"] = "" }
            stepDicts.append(d)
        }
        summary["testes"] = stepDicts
        let tested = steps.filter { !$0.skipped }
        summary["cliquesIneficazes"] = tested.count >= 3 && tested.allSatisfy { $0.verdict == "sem_reacao" }
        summary["testeTotalMs"] = testMs
        summary["testados"] = steps.filter { !$0.skipped }.count
        gotoScroll(cap.originalYpx)
    } else {
        gotoScroll(cap.originalYpx)
    }
    let frontAfter = NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "?"
    summary["focoInalterado"] = (frontBefore == frontAfter)
    summary["appEmFoco"] = frontAfter
    writeJSON(summary, "\(outdir)/resultado.json")
    print("\(outdir)/resultado.json")

case "url":
    if let i = capture(), let ch = i.cropping(to: CGRect(x: 0, y: 0, width: i.width, height: Int(contentTopPt * 2))) {
        let segs = ocrSegments(ch).filter { $0.text.contains("://") || $0.text.hasPrefix("file") }
        print((segs.first?.text ?? "").replacingOccurrences(of: " ", with: "%20"))
    }
case "peek":
    if let i = capture() { saveImage(i, args[2], jpeg: true, maxW: 900) }; print("ok")
case "click":
    guard args.count >= 4, let x = Double(args[2]), let y = Double(args[3]) else { fail("uso: click x y [page|window]") }
    let page = args.count > 4 && args[4] == "page"
    if page {
        let orig = scrollToTop()
        var e = Elem(); e.r = CGRect(x: x * 2, y: y * 2, width: 0, height: 0)
        let p = ensureVisible(e)
        clickAt(p); usleep(150000)
        gotoScroll(orig)
    } else { clickAt(CGPoint(x: x, y: y)) }
    print("ok")
case "key":
    guard args.count >= 3 else { fail("uso: key back|reload") }
    if args[2] == "back" { backKey() } else if args[2] == "reload" { reloadKey() } else if args[2] == "escape" { pressKey(53, cmd: false) } else if args[2] == "f6" { pressKey(97, cmd: false) } else if args[2] == "tab" { pressKey(48, cmd: false) } else if args[2] == "enter" { pressKey(36, cmd: false) } else if args[2] == "forward" { pressKey(30, cmd: true) } else { fail("tecla desconhecida") }
    print("ok")
default: fail("comando desconhecido")
}

extension CGImage {
    static func fromFile(_ path: String) -> CGImage? {
        guard let s = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(s, 0, nil)
    }
}
