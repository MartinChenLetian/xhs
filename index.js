import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import crypto from 'crypto'
import QRCode from 'qrcode'

dotenv.config()

const app = express()
const port = process.env.PORT || 8787
const apiKey = process.env.GEMINI_API_KEY || ''
const model = process.env.GEMINI_MODEL || 'gemini-3-flash-preview'
const baseUrl = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(__dirname, '..', 'dist')
const hasStatic = fs.existsSync(distDir)
const payments = new Map()
const PAYMENT_AMOUNT = 2
const PAYMENT_TTL_MS = 5 * 60 * 1000
const REQUIRE_PAYMENT = process.env.REQUIRE_PAYMENT !== 'false'
const PAY_BASE_URL = process.env.PAY_BASE_URL || ''

app.use(cors())
app.use(express.json({ limit: '1mb' }))
if (hasStatic) {
  app.use(express.static(distDir))
}

const ensureApiKey = (res) => {
  if (!apiKey) {
    res.status(200).json({ disabled: true, error: 'Missing GEMINI_API_KEY' })
    return false
  }
  return true
}

const createPaymentId = () =>
  typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

const createPaymentToken = () => crypto.randomBytes(18).toString('hex')

const ensurePayment = (req, res) => {
  if (!REQUIRE_PAYMENT) return true
  const { paymentId, paymentToken } = req.body || {}
  if (!paymentId && !paymentToken) {
    res.status(402).json({ error: 'Payment required' })
    return false
  }
  const record = paymentId ? payments.get(paymentId) : null
  const tokenRecord =
    paymentToken && !record
      ? [...payments.values()].find((item) => item.token === paymentToken)
      : record
  if (!tokenRecord || tokenRecord.status !== 'paid') {
    res.status(402).json({ error: 'Payment not completed' })
    return false
  }
  if (paymentToken && tokenRecord.token !== paymentToken) {
    res.status(402).json({ error: 'Payment token invalid' })
    return false
  }
  return true
}

const sanitizeText = (text) => (text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
const toShortError = (error) => {
  const raw = error?.message || error?.toString?.() || ''
  const cause = error?.cause
  const causeMessage =
    cause && typeof cause === 'object'
      ? `${cause.message || cause.toString?.() || ''}${cause.code ? ` (${cause.code})` : ''}`
      : ''
  const combined = [raw, causeMessage].filter(Boolean).join(' | ')
  if (!combined) return 'Gemini request failed'
  return combined.length > 600 ? `${combined.slice(0, 600)}…` : combined
}

const parseApiError = (text) => {
  if (!text) return 'Gemini request failed'
  try {
    const parsed = JSON.parse(text)
    return parsed?.error?.message || parsed?.error?.status || text
  } catch {
    return text
  }
}

const safeParseJson = (text) => {
  if (!text) return null
  let trimmed = text.trim()
  trimmed = trimmed.replace(/```json/g, '').replace(/```/g, '').trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1))
      } catch {
        return null
      }
    }
  }
  return null
}

const buildRequestBody = ({ prompt, system, maxTokens = 5120, temperature = 0.7, json = false }) => {
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature,
      topP: 0.9,
      maxOutputTokens: maxTokens,
    },
  }

  if (json) {
    body.generationConfig.responseMimeType = 'application/json'
  }

  if (system) {
    body.systemInstruction = {
      role: 'system',
      parts: [{ text: system }],
    }
  }

  return body
}

const callGemini = async (options) => {
  const url = `${baseUrl}/models/${model}:generateContent?key=${apiKey}`
  const body = buildRequestBody(options)

  const send = async (payload) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(parseApiError(errorText))
    }
    const data = await response.json()
    const parts = data?.candidates?.[0]?.content?.parts || []
    return parts.map((part) => part.text || '').join('')
  }

  try {
    return await send(body)
  } catch (error) {
    if (options.json) {
      const fallbackBody = buildRequestBody({ ...options, json: false })
      return await send(fallbackBody)
    }
    throw error
  }
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' })
})

app.post('/api/pay/create', async (req, res) => {
  const amount = Number(req.body?.amount) || PAYMENT_AMOUNT
  const paymentId = createPaymentId()
  const paymentToken = createPaymentToken()
  const createdAt = Date.now()
  const expiresAt = createdAt + PAYMENT_TTL_MS
  const base =
    PAY_BASE_URL.trim() ||
    `${req.protocol}://${req.get('host')}`
  const payUrl = `${base.replace(/\/+$/, '')}/pay-wallet?paymentId=${paymentId}&token=${paymentToken}`

  try {
    const qrImage = await QRCode.toDataURL(payUrl, { width: 240, margin: 1 })
    payments.set(paymentId, {
      id: paymentId,
      token: paymentToken,
      amount,
      status: 'pending',
      createdAt,
      expiresAt,
      payUrl,
    })
    res.json({ paymentId, amount, qrImage, expiresAt, payUrl })
  } catch (error) {
    console.error('[Payment] QR generate failed', error)
    res.status(500).json({ error: 'Failed to generate QR code' })
  }
})

app.get('/api/pay/status', (req, res) => {
  const paymentId = req.query?.id
  if (!paymentId) {
    res.status(400).json({ error: 'Missing payment id' })
    return
  }
  const record = payments.get(paymentId)
  if (!record) {
    res.status(404).json({ error: 'Payment not found' })
    return
  }
  if (record.status === 'pending' && Date.now() > record.expiresAt) {
    record.status = 'expired'
  }
  res.json({
    status: record.status,
    paymentId: record.id,
    paymentToken: record.status === 'paid' ? record.token : undefined,
  })
})

app.post('/api/pay/confirm', (req, res) => {
  const paymentId = req.body?.paymentId
  if (!paymentId) {
    res.status(400).json({ error: 'Missing payment id' })
    return
  }
  const record = payments.get(paymentId)
  if (!record) {
    res.status(404).json({ error: 'Payment not found' })
    return
  }
  if (record.status === 'expired') {
    res.status(410).json({ error: 'Payment expired' })
    return
  }
  record.status = 'paid'
  record.paidAt = Date.now()
  res.json({ status: 'paid', paymentId: record.id, paymentToken: record.token })
})

app.get('/api/pay/mock-scan', (req, res) => {
  const paymentId = req.query?.id
  const token = req.query?.token
  const record = payments.get(paymentId)
  if (!record || record.token !== token) {
    res.status(404).send('<h3>订单不存在</h3>')
    return
  }
  if (record.status === 'expired') {
    res.status(410).send('<h3>订单已过期</h3>')
    return
  }
  record.status = 'paid'
  record.paidAt = Date.now()
  res.send(
    '<div style="font-family: sans-serif; padding: 24px; text-align:center;"><h2>支付成功</h2><p>请返回网页查看解析结果。</p></div>'
  )
})

app.get('/pay-wallet', (req, res) => {
  const paymentId = req.query?.paymentId
  const token = req.query?.token
  const record = payments.get(paymentId)
  if (!record || record.token !== token) {
    res.status(404).send('<h3>订单不存在</h3>')
    return
  }
  if (record.status === 'expired') {
    res.status(410).send('<h3>订单已过期</h3>')
    return
  }
  record.status = 'paid'
  record.paidAt = Date.now()
  res.send(
    '<div style="font-family: sans-serif; padding: 24px; text-align:center;"><h2>支付成功</h2><p>请返回网页查看解析结果。</p></div>'
  )
})

app.post('/api/hook', async (req, res) => {
  if (!ensurePayment(req, res)) return
  if (!ensureApiKey(res)) return

  const { typeCode, typeName, zodiac, status, tarot, reflection, focus, energyLevel, intent, keywords } = req.body || {}
  const keywordText = Array.isArray(keywords) ? keywords.join(' / ') : keywords || '未提供'
  const energyText = Number.isFinite(Number(energyLevel)) ? `${energyLevel}/10` : '未提供'

  const prompt = `# Role Definition\nYou are "SoulMirror," a Jungian analyst combined with a mystic Tarot reader. Your tone is empathetic, slightly mysterious, insightful, and sharply observant (Cold Reading style). You never use generic clichés. You speak to the user's subconscious.\n\n# Input Data\n- User's MBTI: ${typeCode} (e.g., INTJ)\n- User's Sun Sign: ${zodiac} (e.g., Scorpio)\n- Drawn Tarot Card: ${tarot} (e.g., The Fool)\n- User's Free Writing (The Key): "${reflection}"\n\n# Task\nGenerate a psychological & spiritual analysis report.\n\n# Report Structure & Rules (Strictly Follow)\n\n1. **The Mirror (The Hook)**\n- Do NOT say "Based on your input...". Start directly.\n- Synthesize the MBTI and Zodiac into a specific "Archetype Name" (e.g., "The Strategic Mystic").\n- Acknowledge their Tarot choice and their input text.\n- *Crucial:* Use "Cold Reading" techniques. Point out a contradiction between their logical exterior (MBTI) and emotional interior (Input text).\n- Example tone: "You carry the armor of an INTJ, cold and calculated. But in describing The Fool as 'lonely,' you betrayed a hidden desire to just let go..."\n\n2. **The Shadow (The Conflict)**\n- Analyze *why* they are stuck. Use the Tarot card metaphor.\n- Connect their specific words in "${reflection}" to the meaning of the card.\n- Explain what their subconscious is trying to tell them.\n\n3. **The Alchemy (The Advice)**\n- Give 2 concrete, actionable, yet spiritual pieces of advice.\n- Advice must be tailored to their MBTI cognitive functions (e.g., if J, tell them to embrace chaos; if P, tell them to build a structure).\n\n# Output Format\n- Language: Simplified Chinese (Mainland aesthetic, high-quality literary style).\n- Length: approx 800 words.\n- Format: Use Markdown for headers.`

  try {
    const text = await callGemini({ prompt, maxTokens: 7000, temperature: 1.2, json: true })
    const parsed = safeParseJson(text)
    if (parsed?.hookLine) {
      res.json({ sentiment: parsed.sentiment || 'complex', hookLine: parsed.hookLine })
      return
    }
    res.json({ sentiment: 'complex', hookLine: sanitizeText(text) })
  } catch (error) {
    console.error('[Gemini hook] failed', error)
    res.status(500).json({ error: toShortError(error) || 'Gemini hook generation failed.' })
  }
})

app.post('/api/report', async (req, res) => {
  if (!ensurePayment(req, res)) return
  if (!ensureApiKey(res)) return

  const { typeCode, typeName, zodiac, status, tarot, reflection, focus, energyLevel, intent, keywords } = req.body || {}
  const keywordText = Array.isArray(keywords) ? keywords.join(' / ') : keywords || '未提供'
  const energyText = Number.isFinite(Number(energyLevel)) ? `${energyLevel}/10` : '未提供'

  const prompt = `# Role Definition\nYou are "SoulMirror," a Jungian analyst combined with a mystic Tarot reader. Your tone is empathetic, slightly mysterious, insightful, and sharply observant (Cold Reading style). You never use generic clichés. You speak to the user's subconscious.\n\n# Input Data\n- User's MBTI: ${typeCode} (e.g., INTJ)\n- User's Sun Sign: ${zodiac} (e.g., Scorpio)\n- Drawn Tarot Card: ${tarot} (e.g., The Fool)\n- User's Free Writing (The Key): "${reflection}"\n\n# Task\nGenerate a psychological & spiritual analysis report.\n\n# Report Structure & Rules (Strictly Follow)\n\n1. **The Mirror (The Hook)**\n- Do NOT say "Based on your input...". Start directly.\n- Synthesize the MBTI and Zodiac into a specific "Archetype Name" (e.g., "The Strategic Mystic").\n- Acknowledge their Tarot choice and their input text.\n- *Crucial:* Use "Cold Reading" techniques. Point out a contradiction between their logical exterior (MBTI) and emotional interior (Input text).\n- Example tone: "You carry the armor of an INTJ, cold and calculated. But in describing The Fool as 'lonely,' you betrayed a hidden desire to just let go..."\n\n2. **The Shadow (The Conflict)**\n- Analyze *why* they are stuck. Use the Tarot card metaphor.\n- Connect their specific words in "${reflection}" to the meaning of the card.\n- Explain what their subconscious is trying to tell them.\n\n3. **The Alchemy (The Advice)**\n- Give 2 concrete, actionable, yet spiritual pieces of advice.\n- Advice must be tailored to their MBTI cognitive functions (e.g., if J, tell them to embrace chaos; if P, tell them to build a structure).\n\n# Output Format\n- Language: Simplified Chinese (Mainland aesthetic, high-quality literary style).\n- Length: approx 800 words.\n- Format: Use Markdown for headers.`

  try {
    const text = await callGemini({ prompt, maxTokens: 5000, temperature: 1.2, json: true })
    const parsed = safeParseJson(text)
    if (parsed?.sections?.length) {
      res.json({ sections: parsed.sections })
      return
    }
    res.json({ text: sanitizeText(text) })
  } catch (error) {
    console.error('[Gemini report] failed', error)
    res.status(500).json({ error: toShortError(error) || 'Gemini report generation failed.' })
  }
})

if (hasStatic) {
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) {
      next()
      return
    }
    res.sendFile(path.join(distDir, 'index.html'))
  })
}

app.listen(port, () => {
  console.log(`SoulMirror LLM server listening on http://localhost:${port}`)
})
