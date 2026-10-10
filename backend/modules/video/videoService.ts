import { exec } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const execAsync = promisify(exec)
const XFADE_DURATION = 0.3
const FADE_OUT_DURATION = 0.3

function escPath(p: string): string {
  return p.replace(/\\/g, '/')
}

/** İlk: 2s, orta: 1s, son: 1s + fade out için ek 0.3s */
function buildImageDurations(count: number): number[] {
  if (count <= 0) return []
  if (count === 1) return [2 + FADE_OUT_DURATION]
  const durations = [2]
  for (let i = 1; i < count - 1; i++) durations.push(1)
  durations.push(1 + FADE_OUT_DURATION)
  return durations
}

function buildFilterComplex(n: number, durations: number[]): string {
  const scale =
    'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p'

  const parts: string[] = []
  for (let i = 0; i < n; i++) {
    parts.push(`[${i}:v]${scale}[v${i}]`)
  }

  if (n === 1) {
    const sonGorselBaslangici = 0
    const fadeSt = sonGorselBaslangici + 2
    parts.push(`[v0]fade=t=out:st=${fadeSt}:d=${FADE_OUT_DURATION}[vout]`)
    return parts.join(';')
  }

  let timeline = durations[0]
  let prev = 'v0'
  for (let i = 1; i < n; i++) {
    const offset = timeline - XFADE_DURATION
    const out = i === n - 1 ? 'vmerged' : `vx${i}`
    parts.push(
      `[${prev}][v${i}]xfade=transition=fade:duration=${XFADE_DURATION}:offset=${offset.toFixed(3)}[${out}]`
    )
    timeline = timeline + durations[i] - XFADE_DURATION
    prev = out
  }

  const sonGorselBaslangici =
    durations.slice(0, n - 1).reduce((a, b) => a + b, 0) - XFADE_DURATION
  const fadeSt = sonGorselBaslangici + 1
  parts.push(`[vmerged]fade=t=out:st=${fadeSt.toFixed(3)}:d=${FADE_OUT_DURATION}[vout]`)
  return parts.join(';')
}

export async function createSlideshow(imageUrls: string[], asin: string): Promise<Buffer> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-video-'))
  
  try {
    // 1. Görselleri indir
    const imgPaths: string[] = []
    for (let i = 0; i < Math.min(imageUrls.length, 7); i++) {
      const res = await fetch(imageUrls[i])
      const buf = Buffer.from(await res.arrayBuffer())
      const imgPath = path.join(tmpDir, `img${i}.jpg`)
      fs.writeFileSync(imgPath, buf)
      imgPaths.push(imgPath)
    }

    const n = imgPaths.length
    const durations = buildImageDurations(n)

    // 2. Süre listesi (concat mantığı): ilk 2s, orta 1s, son 1s + fade
    const listPath = path.join(tmpDir, 'list.txt')
    const listLines: string[] = []
    for (let i = 0; i < n; i++) {
      const p = escPath(imgPaths[i])
      let dur: number
      if (i === 0) dur = 2
      else if (i === n - 1) dur = 1
      else dur = 1
      listLines.push(`file '${p}'`, `duration ${dur}`)
    }
    if (n > 0) listLines.push(`file '${escPath(imgPaths[n - 1])}'`)
    fs.writeFileSync(listPath, listLines.join('\n'))

    // 3. FFmpeg: loop input + xfade + son fade out
    const outputPath = path.join(tmpDir, `${asin}.mp4`)
    const inputs = imgPaths
      .map((p, i) => `-loop 1 -t ${durations[i]} -i "${escPath(p)}"`)
      .join(' ')
    const filterComplex = buildFilterComplex(n, durations)
    const cmd =
      `ffmpeg ${inputs} -filter_complex "${filterComplex}" -map "[vout]" ` +
      `-c:v libx264 -r 30 -pix_fmt yuv420p -movflags +faststart "${escPath(outputPath)}" -y`
    await execAsync(cmd)

    // 4. Video buffer'ı döndür
    return fs.readFileSync(outputPath)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

export async function uploadVideoToEbay(
  videoBuffer: Buffer,
  title: string,
  client: any
): Promise<string | null> {
  try {
    const videoId = await client.uploadVideo(videoBuffer, title)
    return videoId
  } catch (e) {
    console.error('[VideoService] Upload failed:', e)
    return null
  }
}
