/** How long a connection test waits for the API server. */
export const API_TEST_TIMEOUT_MS = 8000
/** A cheap, read-only call every Anthropic-style server answers: the model list. */
const PROBE_PATH = '/v1/models'

/**
 * Asks the API server (`GET /v1/models` with the token as a Bearer, like OpenClaw sends it) and says in Vietnamese
 * what came back. Never throws; never contains the token. Redirects are not followed: the token must not travel on
 * to a host the user did not enter.
 */
export async function testApiConnection(baseUrl: string, token: string, timeoutMs: number = API_TEST_TIMEOUT_MS): Promise<string> {
  const started = Date.now()
  try {
    const response = await fetch(`${baseUrl}${PROBE_PATH}`, {
      headers: { authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01' },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
    void response.body?.cancel().catch(() => {}) // the answer is not read: only its status matters
    return describeStatus(response.status, Date.now() - started)
  } catch (err) {
    return describeFailure(err, token, timeoutMs)
  }
}

function describeStatus(status: number, ms: number): string {
  if (status >= 200 && status < 300) return `✅ Kết nối được, server chấp nhận token (HTTP ${status}, ${ms} ms).`
  if (status === 401 || status === 403) return `⚠️ Server trả lời nhưng từ chối token (HTTP ${status}). Kiểm tra lại token.`
  if (status >= 300 && status < 400) return `⚠️ Server chuyển hướng (HTTP ${status}): thử đổi http:// thành https:// hoặc ngược lại.`
  if (status === 404 || status === 405 || status === 501) {
    return `ℹ️ Server trả lời (HTTP ${status}, ${ms} ms) nhưng không có ${PROBE_PATH} nên chưa kiểm được token. Gửi một tin thử cho Claude để chắc chắn.`
  }
  if (status >= 500) return `⚠️ Server báo lỗi (HTTP ${status}). Kiểm tra server API.`
  return `⚠️ Server trả lời lạ (HTTP ${status}).`
}

function describeFailure(err: unknown, token: string, timeoutMs: number): string {
  const { name, code, message } = err as { name?: string; code?: string; message?: string }
  if (name === 'TimeoutError' || name === 'AbortError') {
    return `❌ Không thấy server trả lời sau ${Math.round(timeoutMs / 1000)} giây. Kiểm tra IP, port, tường lửa.`
  }
  if (code === 'ECONNREFUSED') return '❌ Server từ chối kết nối: sai port, hoặc server API chưa chạy.'
  if (code === 'ENOTFOUND') return '❌ Không tìm thấy host: sai IP hoặc tên miền.'
  if (code === 'ECONNRESET') return '❌ Kết nối bị ngắt giữa chừng: thử đổi http:// thành https:// hoặc ngược lại.'
  const detail = (code ?? message ?? 'lỗi không rõ').split(token).join('***').slice(0, 120)
  return `❌ Không kết nối được: ${detail}`
}
