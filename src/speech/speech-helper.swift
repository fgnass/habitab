// Speech recognition helper of Habitab (macOS): on-device dictation with
// Apple's Speech framework, driven by the app over stdin/stdout, one JSON
// object per line. The app offers it to pages as the Web Speech API (see
// page-preload.ts) and uses it for its own dictation.
//
// Requests:
//   {"type":"start","id":1,"lang":"de-DE","interim":true,"context":["Habitab"]}
//   {"type":"stop","id":1}       finishes: pending text becomes final, then "end"
//   {"type":"abort","id":1}      stops without further results, then "end"
//   {"type":"available","id":2,"lang":"de-DE"}
//   {"type":"install","id":3,"lang":"de-DE"}
//   {"type":"languages","id":4}                    → {"type":"languages","id":4,"languages":["de-DE",…]}
// Events:
//   {"type":"started","id":1}                       the microphone is open
//   {"type":"level","id":1,"level":0.4}                 microphone signal, about 12 times a second
//   {"type":"result","id":1,"text":"…","final":false,"confidence":0.9}
//   {"type":"end","id":1}
//   {"type":"error","id":1,"error":"not-allowed","message":"…"}   (error names of the Web Speech API)
//   {"type":"available","id":2,"status":"available"|"downloadable"|"downloading"|"unavailable"}
//   {"type":"installed","id":3,"ok":true}
// An empty "lang" means the user's first preferred language. A "start" with
// "file":"/path.aiff" transcribes that file instead of the microphone and
// ends by itself (for tests).
//
// macOS 26 uses SpeechAnalyzer (the models of Notes and Voice Memos); older
// systems fall back to SFSpeechRecognizer with on-device recognition.
import AVFoundation
import Foundation
import Speech

// MARK: Output

let outQueue = DispatchQueue(label: "habitab.speech.out")
func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object), var line = String(data: data, encoding: .utf8) else { return }
  line += "\n"
  outQueue.sync { FileHandle.standardOutput.write(line.data(using: .utf8)!) }
}
func emitError(_ id: Int, _ error: String, _ message: String) {
  emit(["type": "error", "id": id, "error": error, "message": message])
}

// MARK: Audio source (microphone or a file)

/// Feeds PCM buffers in a wanted format to a sink; from the microphone, or from a file for tests.
/// Reports the signal level (0…1, from the RMS in dB) about 12 times a second.
final class AudioSource {
  private let engine = AVAudioEngine()
  private var fileTask: Task<Void, Never>?
  var onLevel: ((Double) -> Void)?
  private var levelAt = Date.distantPast

  private func report(_ buffer: AVAudioPCMBuffer) {
    guard let onLevel, Date().timeIntervalSince(levelAt) >= 0.08, let data = buffer.floatChannelData, buffer.frameLength > 0 else { return }
    levelAt = Date()
    var sum: Float = 0
    let n = Int(buffer.frameLength)
    for i in 0..<n { let v = data[0][i]; sum += v * v }
    let rms = Double((sum / Float(n)).squareRoot())
    let db = 20 * log10(max(rms, 1e-6))
    onLevel(min(1, max(0, (db + 50) / 45)))
  }

  /// Starts the microphone; `sink` gets buffers in `format`. Returns false when no input is available.
  func startMicrophone(format: AVAudioFormat, sink: @escaping (AVAudioPCMBuffer) -> Void) -> Bool {
    let input = engine.inputNode
    let inputFormat = input.outputFormat(forBus: 0)
    guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else { return false }
    guard let converter = AVAudioConverter(from: inputFormat, to: format) else { return false }
    input.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { [weak self] buffer, _ in
      self?.report(buffer)
      if let converted = AudioSource.convert(buffer, with: converter, to: format) { sink(converted) }
    }
    engine.prepare()
    do { try engine.start() } catch { input.removeTap(onBus: 0); return false }
    return true
  }

  /// Reads a file in chunks of 100 ms, paced like a microphone, then calls `done`.
  func startFile(_ url: URL, format: AVAudioFormat, sink: @escaping (AVAudioPCMBuffer) -> Void, done: @escaping () -> Void) -> Bool {
    guard let file = try? AVAudioFile(forReading: url), let converter = AVAudioConverter(from: file.processingFormat, to: format) else { return false }
    fileTask = Task {
      let frames = AVAudioFrameCount(file.processingFormat.sampleRate / 10)
      while !Task.isCancelled {
        guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: frames) else { break }
        do { try file.read(into: buffer, frameCount: frames) } catch { break }
        if buffer.frameLength == 0 { break }
        self.report(buffer)
        if let converted = AudioSource.convert(buffer, with: converter, to: format) { sink(converted) }
        try? await Task.sleep(nanoseconds: 100_000_000)
      }
      if !Task.isCancelled { done() }
    }
    return true
  }

  func stop() {
    fileTask?.cancel()
    fileTask = nil
    if engine.isRunning { engine.inputNode.removeTap(onBus: 0); engine.stop() }
  }

  private static func convert(_ buffer: AVAudioPCMBuffer, with converter: AVAudioConverter, to format: AVAudioFormat) -> AVAudioPCMBuffer? {
    let ratio = format.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 16
    guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
    var consumed = false
    var error: NSError?
    converter.convert(to: out, error: &error) { _, status in
      if consumed { status.pointee = .noDataNow; return nil }
      consumed = true
      status.pointee = .haveData
      return buffer
    }
    return error == nil && out.frameLength > 0 ? out : nil
  }
}

// MARK: Recognition (SpeechAnalyzer, macOS 26)

protocol Recognition: AnyObject {
  var id: Int { get }
  func stop()
  func abort()
}

@available(macOS 26, *)
final class AnalyzerRecognition: Recognition {
  let id: Int
  private let source = AudioSource()
  private var analyzer: SpeechAnalyzer?
  private var transcriber: SpeechTranscriber?
  private var continuation: AsyncStream<AnalyzerInput>.Continuation?
  private var resultsTask: Task<Void, Never>?
  private var ended = false
  /// The audio source runs ("started" was sent).
  private var listening = false
  private var onEnd: () -> Void

  init(id: Int, onEnd: @escaping () -> Void) {
    self.id = id
    self.onEnd = onEnd
    source.onLevel = { level in emit(["type": "level", "id": id, "level": (level * 100).rounded() / 100]) }
  }

  func start(lang: String, interim: Bool, context: [String], file: String?) {
    Task { await run(lang: lang, interim: interim, context: context, file: file) }
  }

  private func run(lang: String, interim: Bool, context: [String], file: String?) async {
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: lang)) else {
      return fail("language-not-supported", "No on-device model for \(lang)")
    }
    if ended { return }
    let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: interim ? [.volatileResults] : [], attributeOptions: [.transcriptionConfidence])
    self.transcriber = transcriber
    switch await AssetInventory.status(forModules: [transcriber]) {
    case .unsupported: return fail("language-not-supported", "No on-device model for \(lang)")
    case .installed: break
    default:
      if ended { return }
      emit(["type": "downloading", "id": id])
      do { try await AssetInventory.assetInstallationRequest(supporting: [transcriber])?.downloadAndInstall() }
      catch { return fail("language-not-supported", "The model for \(lang) could not be installed: \(error.localizedDescription)") }
    }
    if ended { return }
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
      return fail("audio-capture", "No audio format for the recognizer")
    }
    if ended { return }
    let analysisContext = AnalysisContext()
    if !context.isEmpty { analysisContext.contextualStrings = [.general: context] }
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    self.analyzer = analyzer
    try? await analyzer.setContext(analysisContext)
    if ended { await analyzer.cancelAndFinishNow(); return }
    let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
    self.continuation = continuation
    resultsTask = Task { [weak self] in
      do {
        for try await result in transcriber.results {
          guard let self, !self.ended else { break }
          let text = String(result.text.characters)
          var confidence = 1.0
          if let c = result.text.runs.compactMap({ $0.transcriptionConfidence }).min() { confidence = c }
          emit(["type": "result", "id": self.id, "text": text, "final": result.isFinal, "confidence": confidence])
        }
      } catch {
        self?.fail("network", error.localizedDescription)
      }
    }
    do { try await analyzer.start(inputSequence: stream) }
    catch { return fail("audio-capture", "The recognizer did not start: \(error.localizedDescription)") }
    // Stopped or aborted while the recognizer got ready: the microphone does not open.
    if ended { await analyzer.cancelAndFinishNow(); return }
    let sink: (AVAudioPCMBuffer) -> Void = { [weak self] buffer in self?.continuation?.yield(AnalyzerInput(buffer: buffer)) }
    let started: Bool
    if let file {
      started = source.startFile(URL(fileURLWithPath: file), format: format, sink: sink, done: { [weak self] in self?.stop() })
    } else {
      if AVCaptureDevice.authorizationStatus(for: .audio) == .denied { return fail("not-allowed", "Microphone access is denied") }
      started = source.startMicrophone(format: format, sink: sink)
    }
    guard started else { return fail("audio-capture", "No microphone is available") }
    listening = true
    emit(["type": "started", "id": id])
  }

  func stop() {
    guard !ended else { return }
    // Before the microphone opened there is nothing to finish: no audio, no text.
    guard listening else { return abort() }
    source.stop()
    continuation?.finish()
    Task {
      try? await analyzer?.finalizeAndFinishThroughEndOfInput()
      await resultsTask?.value
      finish()
    }
  }

  func abort() {
    guard !ended else { return }
    ended = true
    source.stop()
    continuation?.finish()
    resultsTask?.cancel()
    Task { await analyzer?.cancelAndFinishNow(); emit(["type": "end", "id": id]); onEnd() }
  }

  private func fail(_ error: String, _ message: String) {
    guard !ended else { return }
    emitError(id, error, message)
    abort()
  }

  private func finish() {
    guard !ended else { return }
    ended = true
    emit(["type": "end", "id": id])
    onEnd()
  }
}

// MARK: Recognition (SFSpeechRecognizer, macOS 13–15)

final class LegacyRecognition: Recognition {
  let id: Int
  private let source = AudioSource()
  private var task: SFSpeechRecognitionTask?
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var ended = false
  /// The audio source runs ("started" was sent).
  private var listening = false
  private var onEnd: () -> Void

  init(id: Int, onEnd: @escaping () -> Void) {
    self.id = id
    self.onEnd = onEnd
    source.onLevel = { level in emit(["type": "level", "id": id, "level": (level * 100).rounded() / 100]) }
  }

  func start(lang: String, interim: Bool, context: [String], file: String?) {
    SFSpeechRecognizer.requestAuthorization { [self] status in
      DispatchQueue.main.async { [self] in
        // Stopped or aborted while macOS asked: the microphone does not open.
        if ended { return }
        guard status == .authorized else { return fail("not-allowed", "Speech recognition is not allowed") }
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: lang)), recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else {
          return fail("language-not-supported", "No on-device recognition for \(lang)")
        }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = interim
        request.requiresOnDeviceRecognition = true
        request.contextualStrings = context
        if #available(macOS 13, *) { request.addsPunctuation = true }
        self.request = request
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
          guard let self, !self.ended else { return }
          if let result {
            let t = result.bestTranscription
            let confidence = t.segments.map(\.confidence).min().map(Double.init) ?? 1
            emit(["type": "result", "id": self.id, "text": t.formattedString, "final": result.isFinal, "confidence": confidence])
            if result.isFinal { self.finish() }
          } else if let error {
            // Ending the audio without speech reports an error too; that is a normal end.
            self.request == nil ? self.finish() : self.fail("network", error.localizedDescription)
          }
        }
        let format = AVAudioFormat(standardFormatWithSampleRate: 16000, channels: 1)!
        let sink: (AVAudioPCMBuffer) -> Void = { [weak self] buffer in self?.request?.append(buffer) }
        let started: Bool
        if let file {
          started = source.startFile(URL(fileURLWithPath: file), format: format, sink: sink, done: { [weak self] in self?.stop() })
        } else {
          if AVCaptureDevice.authorizationStatus(for: .audio) == .denied { return fail("not-allowed", "Microphone access is denied") }
          started = source.startMicrophone(format: format, sink: sink)
        }
        guard started else { return fail("audio-capture", "No microphone is available") }
        listening = true
        emit(["type": "started", "id": id])
      }
    }
  }

  func stop() {
    guard !ended else { return }
    // Before the microphone opened there is nothing to finish: no audio, no text.
    guard let request, listening else { return abort() }
    source.stop()
    self.request = nil
    request.endAudio()
    // The final result follows from the task; a task without any speech ends with an error (handled as a normal end).
  }

  func abort() {
    guard !ended else { return }
    source.stop()
    request = nil
    task?.cancel()
    finish()
  }

  private func fail(_ error: String, _ message: String) {
    guard !ended else { return }
    emitError(id, error, message)
    abort()
  }

  private func finish() {
    guard !ended else { return }
    ended = true
    task = nil
    emit(["type": "end", "id": id])
    onEnd()
  }
}

// MARK: Requests

var current: Recognition?

func handle(_ req: [String: Any]) {
  guard let type = req["type"] as? String, let id = req["id"] as? Int else { return }
  let lang = (req["lang"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? Locale.preferredLanguages.first ?? Locale.current.identifier
  switch type {
  case "start":
    // One microphone: a new recognition ends the running one.
    current?.abort()
    let interim = req["interim"] as? Bool ?? false
    let context = (req["context"] as? [String] ?? []).prefix(100).map { String($0.prefix(60)) }
    let file = req["file"] as? String
    let onEnd = { DispatchQueue.main.async { if current?.id == id { current = nil } } }
    if #available(macOS 26, *) {
      let r = AnalyzerRecognition(id: id, onEnd: onEnd)
      current = r
      r.start(lang: lang, interim: interim, context: context, file: file)
    } else {
      let r = LegacyRecognition(id: id, onEnd: onEnd)
      current = r
      r.start(lang: lang, interim: interim, context: context, file: file)
    }
  case "stop": if current?.id == id { current?.stop() }
  case "abort": if current?.id == id { current?.abort() }
  case "available":
    Task {
      var status = "unavailable"
      if #available(macOS 26, *) {
        if let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: lang)) {
          let t = SpeechTranscriber(locale: locale, preset: .transcription)
          switch await AssetInventory.status(forModules: [t]) {
          case .installed: status = "available"
          case .downloading: status = "downloading"
          case .supported: status = "downloadable"
          default: break
          }
        }
      } else if let r = SFSpeechRecognizer(locale: Locale(identifier: lang)), r.supportsOnDeviceRecognition { status = "available" }
      emit(["type": "available", "id": id, "status": status])
    }
  case "languages":
    Task {
      var codes: [String]
      if #available(macOS 26, *) { codes = await SpeechTranscriber.supportedLocales.map(\.identifier) }
      else { codes = SFSpeechRecognizer.supportedLocales().map(\.identifier) }
      emit(["type": "languages", "id": id, "languages": codes.map { $0.replacingOccurrences(of: "_", with: "-") }.sorted()])
    }
  case "install":
    Task {
      var ok = false
      if #available(macOS 26, *), let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: lang)) {
        let t = SpeechTranscriber(locale: locale, preset: .transcription)
        do { try await AssetInventory.assetInstallationRequest(supporting: [t])?.downloadAndInstall(); ok = true } catch {}
      }
      emit(["type": "installed", "id": id, "ok": ok])
    }
  default: break
  }
}

// stdin on a thread; everything else on the main queue. EOF ends the helper.
Thread {
  while let line = readLine() {
    guard let data = line.data(using: .utf8), let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
    DispatchQueue.main.async { handle(obj) }
  }
  DispatchQueue.main.async { current?.abort(); exit(0) }
}.start()
signal(SIGTERM) { _ in exit(0) }
RunLoop.main.run()
