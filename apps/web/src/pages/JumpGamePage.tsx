import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, RotateCcw } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

const CANVAS_W = 400
const CANVAS_H = 600
const GRAVITY = 0.5
const JUMP_FORCE = -10
const MOVE_SPEED = 5
const PLATFORM_W = 70
const PLATFORM_H = 12
const PLAYER_SIZE = 24

interface Platform {
  x: number
  y: number
  w: number
  h: number
  broken: boolean
  touched: boolean
}

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  color: string
}

export default function JumpGamePage() {
  const navigate = useNavigate()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [score, setScore] = useState(0)
  const [gameOver, setGameOver] = useState(false)
  const [started, setStarted] = useState(false)
  const stateRef = useRef({
    player: { x: CANVAS_W / 2, y: CANVAS_H - 100, vy: 0 },
    platforms: [] as Platform[],
    particles: [] as Particle[],
    score: 0,
    gameOver: false,
    keys: new Set<string>(),
    cameraY: 0,
    lastPlatformY: CANVAS_H,
    frameId: 0,
  })

  const initPlatforms = useCallback(() => {
    const s = stateRef.current
    s.platforms = []
    s.lastPlatformY = CANVAS_H
    for (let i = 0; i < 8; i++) {
      const y = CANVAS_H - i * 80
      const x = Math.random() * (CANVAS_W - PLATFORM_W)
      s.platforms.push({
        x,
        y,
        w: PLATFORM_W,
        h: PLATFORM_H,
        broken: false,
        touched: false,
      })
      s.lastPlatformY = y
    }
    s.player = { x: CANVAS_W / 2 - PLAYER_SIZE / 2, y: CANVAS_H - 100, vy: 0 }
    s.cameraY = 0
    s.score = 0
    s.gameOver = false
    s.particles = []
    setScore(0)
    setGameOver(false)
  }, [])

  const spawnParticles = useCallback((x: number, y: number, color: string, count: number) => {
    const s = stateRef.current
    for (let i = 0; i < count; i++) {
      s.particles.push({
        x,
        y,
        vx: (Math.random() - 0.5) * 6,
        vy: (Math.random() - 0.5) * 6 - 2,
        life: 1,
        color,
      })
    }
  }, [])

  const startGame = useCallback(() => {
    setStarted(true)
    initPlatforms()
  }, [initPlatforms])

  useEffect(() => {
    if (!started) return

    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const s = stateRef.current

    function addPlatform() {
      const y = s.lastPlatformY - 80
      const x = Math.random() * (CANVAS_W - PLATFORM_W)
      const broken = Math.random() < 0.15
      s.platforms.push({ x, y, w: PLATFORM_W, h: PLATFORM_H, broken, touched: false })
      s.lastPlatformY = y
    }

    function update() {
      if (s.gameOver) return

      const p = s.player
      const left = s.keys.has('ArrowLeft') || s.keys.has('a')
      const right = s.keys.has('ArrowRight') || s.keys.has('d')

      if (left) p.x -= MOVE_SPEED
      if (right) p.x += MOVE_SPEED

      p.x = Math.max(0, Math.min(CANVAS_W - PLAYER_SIZE, p.x))
      p.vy += GRAVITY
      p.y += p.vy

      const playerCenterX = p.x + PLAYER_SIZE / 2
      const playerBottom = p.y + PLAYER_SIZE

      for (const plat of s.platforms) {
        if (plat.broken && plat.touched) continue
        if (
          p.vy >= 0 &&
          playerBottom >= plat.y &&
          playerBottom <= plat.y + plat.h + p.vy &&
          playerCenterX >= plat.x &&
          playerCenterX <= plat.x + plat.w
        ) {
          if (plat.broken) {
            plat.touched = true
            spawnParticles(plat.x + plat.w / 2, plat.y, '#ef4444', 8)
          } else {
            p.vy = JUMP_FORCE
            plat.touched = true
            spawnParticles(playerCenterX, plat.y, '#22c55e', 5)
          }
          break
        }
      }

      const screenCenter = CANVAS_H * 0.35
      if (p.y < screenCenter) {
        const diff = screenCenter - p.y
        s.cameraY += diff
        p.y = screenCenter
        for (const plat of s.platforms) {
          plat.y += diff
        }
        s.lastPlatformY += diff
        s.score += Math.floor(diff)
      }

      s.platforms = s.platforms.filter((plat) => plat.y < CANVAS_H + 50)
      while (s.lastPlatformY > -50) {
        addPlatform()
      }

      s.particles = s.particles
        .map((pt) => ({
          ...pt,
          x: pt.x + pt.vx,
          y: pt.y + pt.vy,
          vy: pt.vy + 0.1,
          life: pt.life - 0.02,
        }))
        .filter((pt) => pt.life > 0)

      if (p.y > CANVAS_H + 50) {
        s.gameOver = true
        setGameOver(true)
        setScore(s.score)
        spawnParticles(p.x + PLAYER_SIZE / 2, p.y - s.cameraY, '#f59e0b', 15)
      }
    }

    function draw() {
      ctx!.clearRect(0, 0, CANVAS_W, CANVAS_H)

      const grad = ctx!.createLinearGradient(0, 0, 0, CANVAS_H)
      grad.addColorStop(0, '#0f172a')
      grad.addColorStop(0.5, '#1e293b')
      grad.addColorStop(1, '#0f172a')
      ctx!.fillStyle = grad
      ctx!.fillRect(0, 0, CANVAS_W, CANVAS_H)

      for (let i = 0; i < 40; i++) {
        const y = ((i * 30 + s.cameraY * 0.5) % (CANVAS_H + 60)) - 30
        ctx!.fillStyle = `rgba(255,255,255,${0.03 + Math.sin(i * 1.5) * 0.02})`
        ctx!.beginPath()
        ctx!.arc((i * 47 + 13) % CANVAS_W, y, 1, 0, Math.PI * 2)
        ctx!.fill()
      }

      for (const plat of s.platforms) {
        const visible = plat.y > -20 && plat.y < CANVAS_H + 20
        if (!visible) continue

        if (plat.broken && plat.touched) {
          ctx!.fillStyle = 'rgba(239,68,68,0.3)'
          ctx!.fillRect(plat.x, plat.y, plat.w, plat.h)
          continue
        }

        const grad2 = ctx!.createLinearGradient(0, plat.y, 0, plat.y + plat.h)
        if (plat.broken) {
          grad2.addColorStop(0, '#f87171')
          grad2.addColorStop(1, '#dc2626')
        } else {
          grad2.addColorStop(0, '#a78bfa')
          grad2.addColorStop(1, '#7c3aed')
        }
        ctx!.fillStyle = grad2
        ctx!.beginPath()
        ctx!.roundRect(plat.x, plat.y, plat.w, plat.h, 4)
        ctx!.fill()

        if (!plat.broken) {
          ctx!.fillStyle = 'rgba(255,255,255,0.3)'
          ctx!.beginPath()
          ctx!.roundRect(plat.x + 4, plat.y + 2, plat.w - 8, 4, 2)
          ctx!.fill()
        }
      }

      const px = s.player.x
      const py = s.player.y
      ctx!.fillStyle = '#fbbf24'
      ctx!.beginPath()
      ctx!.roundRect(px, py, PLAYER_SIZE, PLAYER_SIZE, 6)
      ctx!.fill()

      ctx!.fillStyle = '#ffffff'
      ctx!.beginPath()
      ctx!.arc(px + 6, py + 8, 3, 0, Math.PI * 2)
      ctx!.fill()
      ctx!.beginPath()
      ctx!.arc(px + 18, py + 8, 3, 0, Math.PI * 2)
      ctx!.fill()

      ctx!.fillStyle = '#ef4444'
      ctx!.beginPath()
      ctx!.arc(px + 12, py + 16, 3, 0, Math.PI)
      ctx!.fill()

      for (const pt of s.particles) {
        ctx!.globalAlpha = pt.life
        ctx!.fillStyle = pt.color
        ctx!.beginPath()
        ctx!.arc(pt.x, pt.y, 3, 0, Math.PI * 2)
        ctx!.fill()
      }
      ctx!.globalAlpha = 1
    }

    function loop() {
      update()
      draw()
      s.frameId = requestAnimationFrame(loop)
    }

    loop()

    return () => {
      cancelAnimationFrame(s.frameId)
    }
  }, [started, initPlatforms, spawnParticles])

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (['ArrowLeft', 'ArrowRight', 'a', 'd'].includes(e.key)) {
        e.preventDefault()
        stateRef.current.keys.add(e.key)
      }
    }
    function handleKeyUp(e: KeyboardEvent) {
      stateRef.current.keys.delete(e.key)
    }

    window.addEventListener('keydown', handleKey)
    window.addEventListener('keyup', handleKeyUp)
    return () => {
      window.removeEventListener('keydown', handleKey)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [])

  return (
    <div className="flex h-full items-center justify-center bg-[#0a0f1e]">
      <div className="relative flex flex-col items-center gap-4">
        <canvas
          ref={canvasRef}
          width={CANVAS_W}
          height={CANVAS_H}
          className="rounded-2xl shadow-[0_0_60px_rgba(168,85,247,0.15)]"
        />

        {!started && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 rounded-2xl bg-black/60 backdrop-blur-sm">
            <h1 className="text-4xl font-bold text-white drop-shadow-lg">跳跃小游戏</h1>
            <p className="text-sm text-zinc-300">← → 或 A/D 移动 · 跳到平台上得分</p>
            <button
              onClick={startGame}
              className="rounded-xl bg-gradient-to-r from-violet-500 to-purple-600 px-8 py-3 text-lg font-bold text-white shadow-lg transition hover:scale-105 hover:shadow-2xl"
            >
              开始游戏
            </button>
          </div>
        )}

        {gameOver && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 rounded-2xl bg-black/70 backdrop-blur-sm">
            <h2 className="text-3xl font-bold text-white">游戏结束</h2>
            <p className="text-2xl font-bold text-yellow-400">得分: {score}</p>
            <div className="flex gap-3">
              <button
                onClick={startGame}
                className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-violet-500 to-purple-600 px-6 py-2.5 font-bold text-white shadow-lg transition hover:scale-105"
              >
                <RotateCcw className="h-4 w-4" />
                再来一次
              </button>
              <button
                onClick={() => navigate('/')}
                className="flex items-center gap-2 rounded-xl bg-zinc-700 px-6 py-2.5 font-bold text-white transition hover:bg-zinc-600"
              >
                <ArrowLeft className="h-4 w-4" />
                返回
              </button>
            </div>
          </div>
        )}

        {started && !gameOver && (
          <div className="absolute left-4 top-4 rounded-lg bg-black/50 px-3 py-1.5 text-sm font-bold text-white backdrop-blur">
            得分: {score}
          </div>
        )}

        <div className="flex items-center gap-4 text-xs text-zinc-500">
          <span>← → 或 A/D 移动</span>
          <span>·</span>
          <button
            onClick={() => navigate('/')}
            className="text-zinc-400 underline transition hover:text-white"
          >
            返回首页
          </button>
        </div>
      </div>
    </div>
  )
}
