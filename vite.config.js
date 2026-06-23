import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { generateImageMedia, generateVideoMedia, getGenerationCapabilities } from './lib/mediaGeneration.mjs'
import { OFFICIAL_EXCALIDRAW_README, createExcalidrawView, insertExcalidrawImage, insertExcalidrawVideo } from './lib/canvasScene.mjs'

const projectDir = resolve(process.env.EXCALIDRAW_PROJECT_DIR ?? process.cwd())
const canvasDir = resolve(process.env.EXCALIDRAW_CANVAS_DIR ?? join(projectDir, 'canvas'))
const canvasFile = join(canvasDir, 'excalidraw-canvas.json')
const selectionFile = join(canvasDir, 'excalidraw-selection.json')
const viewStateFile = join(canvasDir, 'excalidraw-view-state.json')
const canvasAssetsDir = join(canvasDir, 'assets')
const canvasAssetsRoute = '/excalidraw-assets/'
const defaultPort = Number(process.env.EXCALIDRAW_PORT ?? 43219)

const mimeTypes = new Map([
  ['.apng', 'image/apng'],
  ['.avif', 'image/avif'],
  ['.gif', 'image/gif'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.m4v', 'video/mp4'],
  ['.mov', 'video/quicktime'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm']
])

const canvasEventClients = new Set()
let canvasEventVersion = 0

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(payload))
}

function readRequestBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 50 * 1024 * 1024) {
        rejectBody(new Error('Excalidraw payload is too large.'))
        req.destroy()
      }
    })
    req.on('end', () => resolveBody(body))
    req.on('error', rejectBody)
  })
}

function isSafeChildPath(parent, child) {
  const pathToChild = relative(parent, child)
  return pathToChild && !pathToChild.startsWith('..') && !pathToChild.includes(`..${sep}`)
}

function isScene(value) {
  return value && typeof value === 'object' && Array.isArray(value.elements)
}

function normalizeScene(value) {
  if (!isScene(value)) {
    return {
      type: 'excalidraw',
      version: 2,
      source: 'codex-excalidraw-canvas',
      elements: [],
      appState: {
        viewBackgroundColor: '#ffffff'
      },
      files: {}
    }
  }

  return {
    type: value.type ?? 'excalidraw',
    version: value.version ?? 2,
    source: value.source ?? 'codex-excalidraw-canvas',
    elements: value.elements,
    appState: value.appState && typeof value.appState === 'object' ? value.appState : {},
    files: value.files && typeof value.files === 'object' ? value.files : {}
  }
}

function isSelectionState(value) {
  return value && typeof value === 'object' && Array.isArray(value.selectedElements)
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function isViewState(value) {
  return (
    value &&
    typeof value === 'object' &&
    value.version === 1 &&
    isFiniteNumber(value.scrollX) &&
    isFiniteNumber(value.scrollY) &&
    value.zoom &&
    typeof value.zoom === 'object' &&
    isFiniteNumber(value.zoom.value)
  )
}

async function readJsonFile(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

async function writeJsonAtomic(filePath, payload) {
  await mkdir(dirname(filePath), { recursive: true })
  const tempFile = `${filePath}.${process.pid}.tmp`
  await writeFile(tempFile, `${JSON.stringify(payload, null, 2)}\n`)
  await rename(tempFile, filePath)
}

function broadcastCanvasChanged(paths) {
  const payload = {
    version: ++canvasEventVersion,
    updatedAt: new Date().toISOString(),
    paths
  }

  for (const client of canvasEventClients) {
    if (client.destroyed) {
      canvasEventClients.delete(client)
      continue
    }

    try {
      client.write('event: canvas-changed\n')
      client.write(`id: ${payload.version}\n`)
      client.write(`data: ${JSON.stringify(payload)}\n\n`)
    } catch {
      canvasEventClients.delete(client)
    }
  }
}

function localAssetFilePathFromUrl(pathname) {
  if (!pathname.startsWith(canvasAssetsRoute)) return null
  const requestedPath = decodeURIComponent(pathname.slice(canvasAssetsRoute.length))
  const filePath = resolve(canvasAssetsDir, requestedPath)
  return isSafeChildPath(canvasAssetsDir, filePath) ? filePath : null
}

async function serveCanvasAsset(req, res, next) {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (!url.pathname.startsWith(canvasAssetsRoute)) {
    next()
    return
  }

  const filePath = localAssetFilePathFromUrl(url.pathname)
  if (!filePath) {
    res.statusCode = 403
    res.end('Forbidden')
    return
  }

  try {
    const fileStat = await stat(filePath)
    if (!fileStat.isFile()) {
      res.statusCode = 404
      res.end('Not found')
      return
    }
    res.statusCode = 200
    res.setHeader('content-type', mimeTypes.get(extname(filePath).toLowerCase()) ?? 'application/octet-stream')
    res.setHeader('content-length', String(fileStat.size))
    res.setHeader('cache-control', 'no-cache')
    createReadStream(filePath).pipe(res)
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.statusCode = 404
      res.end('Not found')
      return
    }
    next(error)
  }
}

const MCP_SERVER_NAME = 'Codex Excalidraw Local Canvas MCP'
const MCP_SERVER_VERSION = '0.1.0'
const TOOL_READ_ME = 'read_me'
const TOOL_CREATE_VIEW = 'create_view'
const TOOL_GET_SELECTION = 'get_excalidraw_selection'
const TOOL_INSERT_IMAGE = 'insert_excalidraw_image'
const TOOL_INSERT_VIDEO = 'insert_excalidraw_video'
const TOOL_GENERATE_IMAGE = 'generate_excalidraw_image'
const TOOL_GENERATE_VIDEO = 'generate_excalidraw_video'

function mcpToolDefinitions() {
  return [
    {
      name: TOOL_READ_ME,
      title: 'Read Excalidraw MCP Format',
      description: 'Return the official-compatible Excalidraw element format for create_view.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    {
      name: TOOL_CREATE_VIEW,
      title: 'Create Excalidraw View',
      description: 'Official-compatible create_view tool. Writes Excalidraw-like elements into the live local browser canvas.',
      inputSchema: {
        type: 'object',
        properties: {
          elements: { type: 'string', description: 'JSON array string of Excalidraw-like elements.' },
          append: { type: 'boolean', description: 'Append instead of replacing the previous official-compatible MCP view.' },
          clearCanvas: { type: 'boolean', description: 'Mark all existing elements deleted before adding this view.' },
          dryRun: { type: 'boolean', description: 'Parse and plan without saving.' }
        },
        required: ['elements'],
        additionalProperties: false
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    {
      name: TOOL_GET_SELECTION,
      title: 'Get Excalidraw Selection',
      description: 'Return selected elements from the live local Excalidraw browser canvas.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    {
      name: TOOL_INSERT_IMAGE,
      title: 'Insert Excalidraw Image',
      description: 'Copy a local bitmap into canvas/assets, create an Excalidraw image file and element, and update the live browser canvas.',
      inputSchema: {
        type: 'object',
        properties: {
          imagePath: { type: 'string' },
          anchorElementId: { type: 'string' },
          sourceElementId: { type: 'string' },
          fileName: { type: 'string' },
          placement: { type: 'string', enum: ['right', 'left', 'below', 'replace', 'inside'] },
          margin: { type: 'number' },
          matchAnchor: { type: 'boolean' },
          replaceAnchor: { type: 'boolean' },
          displayWidth: { type: 'number' },
          displayHeight: { type: 'number' },
          customData: { type: 'object' },
          dryRun: { type: 'boolean' }
        },
        required: ['imagePath'],
        additionalProperties: false
      }
    },
    {
      name: TOOL_INSERT_VIDEO,
      title: 'Insert Excalidraw Video',
      description: 'Copy a local video into canvas/assets, create a linked video card, and update the live browser canvas.',
      inputSchema: {
        type: 'object',
        properties: {
          videoPath: { type: 'string' },
          anchorElementId: { type: 'string' },
          sourceElementId: { type: 'string' },
          fileName: { type: 'string' },
          placement: { type: 'string', enum: ['right', 'left', 'below', 'replace', 'inside'] },
          margin: { type: 'number' },
          matchAnchor: { type: 'boolean' },
          replaceAnchor: { type: 'boolean' },
          displayWidth: { type: 'number' },
          displayHeight: { type: 'number' },
          aspectRatio: { type: 'string' },
          prompt: { type: 'string' },
          model: { type: 'string' },
          customData: { type: 'object' },
          dryRun: { type: 'boolean' }
        },
        required: ['videoPath'],
        additionalProperties: false
      }
    },
    {
      name: TOOL_GENERATE_IMAGE,
      title: 'Generate Excalidraw Image',
      description: 'Generate an image with GPT-Image-2.0(Codex) or Grok Imagine(Hermes), insert it, and update the live browser canvas.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          model: { type: 'string', enum: ['gpt-image-2-codex', 'grok-imagine-image-hermes'] },
          anchorElementId: { type: 'string' },
          sourceElementId: { type: 'string' },
          fileName: { type: 'string' },
          imageName: { type: 'string' },
          aspectRatio: { type: 'string' },
          aspect_ratio: { type: 'string' },
          imageSize: { type: 'string' },
          quality: { type: 'string' },
          referenceImagePaths: { type: 'array', items: { type: 'string' } },
          reference_image_paths: { type: 'array', items: { type: 'string' } },
          placement: { type: 'string', enum: ['right', 'left', 'below', 'replace', 'inside'] },
          margin: { type: 'number' },
          matchAnchor: { type: 'boolean' },
          replaceAnchor: { type: 'boolean' },
          displayWidth: { type: 'number' },
          displayHeight: { type: 'number' },
          customData: { type: 'object' },
          dryRun: { type: 'boolean' }
        },
        required: ['prompt'],
        additionalProperties: false
      }
    },
    {
      name: TOOL_GENERATE_VIDEO,
      title: 'Generate Excalidraw Video',
      description: 'Generate a video with Grok Imagine(Hermes), insert a linked video card, and update the live browser canvas.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          model: { type: 'string', enum: ['grok-imagine-video-hermes'] },
          anchorElementId: { type: 'string' },
          sourceElementId: { type: 'string' },
          fileName: { type: 'string' },
          videoName: { type: 'string' },
          aspectRatio: { type: 'string' },
          aspect_ratio: { type: 'string' },
          duration: { type: 'string' },
          resolution: { type: 'string' },
          startFramePath: { type: 'string' },
          start_frame_path: { type: 'string' },
          referenceImagePaths: { type: 'array', items: { type: 'string' } },
          reference_image_paths: { type: 'array', items: { type: 'string' } },
          placement: { type: 'string', enum: ['right', 'left', 'below', 'replace', 'inside'] },
          margin: { type: 'number' },
          matchAnchor: { type: 'boolean' },
          replaceAnchor: { type: 'boolean' },
          displayWidth: { type: 'number' },
          displayHeight: { type: 'number' },
          customData: { type: 'object' },
          dryRun: { type: 'boolean' }
        },
        required: ['prompt'],
        additionalProperties: false
      }
    }
  ]
}

function mcpResult(id, result) {
  return { jsonrpc: '2.0', id, result }
}

function mcpError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

function mcpToolResponse(text, structuredContent) {
  return {
    content: [{ type: 'text', text }],
    structuredContent
  }
}

async function callLocalMcpTool(name, args = {}) {
  const localArgs = { ...(args && typeof args === 'object' ? args : {}), canvasDir }

  if (name === TOOL_READ_ME) {
    return mcpToolResponse(OFFICIAL_EXCALIDRAW_README, { ok: true })
  }

  if (name === TOOL_CREATE_VIEW) {
    const result = await createExcalidrawView(localArgs)
    if (!result.dryRun) broadcastCanvasChanged([canvasFile])
    return mcpToolResponse(`${result.dryRun ? 'Planned' : 'Created'} Excalidraw view with ${result.addedElementCount} element(s).`, result)
  }

  if (name === TOOL_GET_SELECTION) {
    const selection = await readJsonFile(selectionFile).catch((error) => {
      if (error.code === 'ENOENT') return { selectedElements: [], selectedElementIds: [], updatedAt: null }
      throw error
    })
    const scene = await readJsonFile(canvasFile).then(normalizeScene).catch((error) => {
      if (error.code === 'ENOENT') return normalizeScene(null)
      throw error
    })
    return mcpToolResponse(
      selection.selectedElements?.length ? `${selection.selectedElements.length} selected element(s).` : 'No Excalidraw elements are currently selected.',
      { selection, selectionFile, sceneFile: canvasFile, sceneElementCount: scene.elements.length }
    )
  }

  if (name === TOOL_INSERT_IMAGE) {
    const result = await insertExcalidrawImage(localArgs)
    if (!result.dryRun) broadcastCanvasChanged([canvasFile, result.assetFile])
    return mcpToolResponse(`${result.dryRun ? 'Planned' : 'Inserted'} image ${result.elementId}.`, result)
  }

  if (name === TOOL_INSERT_VIDEO) {
    const result = await insertExcalidrawVideo(localArgs)
    if (!result.dryRun) broadcastCanvasChanged([canvasFile, result.assetFile])
    return mcpToolResponse(`${result.dryRun ? 'Planned' : 'Inserted'} video card ${result.elementId}.`, result)
  }

  if (name === TOOL_GENERATE_IMAGE) {
    const media = await generateImageMedia(localArgs)
    const result = await insertExcalidrawImage({
      ...localArgs,
      mediaBuffer: media.buffer,
      mimeType: media.mimeType,
      fileName: localArgs.fileName || localArgs.imageName || localArgs.image_name || media.fileName,
      customData: {
        codexGeneratedImage: true,
        codexGenerationModel: media.model,
        codexGenerationPrompt: localArgs.prompt,
        codexGenerationAspectRatio: localArgs.aspectRatio ?? localArgs.aspect_ratio,
        codexGenerationQuality: localArgs.quality,
        generatorPrompt: localArgs.prompt,
        generatorModel: localArgs.model,
        generatorAspectRatio: localArgs.aspectRatio ?? localArgs.aspect_ratio,
        generatorImageQuality: localArgs.quality,
        generatorImageSize: localArgs.imageSize ?? localArgs.size ?? '1K',
        codexGenerationSource: media.source,
        ...(localArgs.customData && typeof localArgs.customData === 'object' ? localArgs.customData : {})
      }
    })
    if (!result.dryRun) broadcastCanvasChanged([canvasFile, result.assetFile])
    return mcpToolResponse(`${result.dryRun ? 'Planned' : 'Generated'} image ${result.elementId}.`, { kind: 'image', model: media.model, ...result })
  }

  if (name === TOOL_GENERATE_VIDEO) {
    const media = await generateVideoMedia(localArgs)
    const result = await insertExcalidrawVideo({
      ...localArgs,
      mediaBuffer: media.buffer,
      mimeType: media.mimeType,
      fileName: localArgs.fileName || localArgs.videoName || localArgs.video_name || media.fileName,
      aspectRatio: localArgs.aspectRatio ?? localArgs.aspect_ratio,
      duration: localArgs.duration,
      prompt: localArgs.prompt,
      model: media.model,
      customData: {
        codexGeneratedVideo: true,
        codexGenerationModel: media.model,
        codexGenerationPrompt: localArgs.prompt,
        codexGenerationAspectRatio: localArgs.aspectRatio ?? localArgs.aspect_ratio,
        codexGenerationDuration: localArgs.duration,
        codexGenerationResolution: localArgs.resolution,
        videoPrompt: localArgs.prompt,
        videoModel: localArgs.model,
        videoAspectRatio: localArgs.aspectRatio ?? localArgs.aspect_ratio,
        videoDuration: localArgs.duration,
        videoResolution: localArgs.resolution,
        codexGenerationSource: media.source,
        ...(localArgs.customData && typeof localArgs.customData === 'object' ? localArgs.customData : {})
      }
    })
    if (!result.dryRun) broadcastCanvasChanged([canvasFile, result.assetFile])
    return mcpToolResponse(`${result.dryRun ? 'Planned' : 'Generated'} video card ${result.elementId}.`, { kind: 'video', model: media.model, ...result })
  }

  throw new Error(`Unknown tool: ${name}`)
}

async function handleMcpMessage(message) {
  if (!message || typeof message !== 'object') return mcpError(null, -32600, 'Invalid JSON-RPC request.')
  const { id, method, params } = message

  if (method === 'initialize') {
    return mcpResult(id, {
      protocolVersion: params?.protocolVersion ?? '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      instructions:
        'This MCP endpoint controls the local Excalidraw browser canvas at the same origin. Use read_me/create_view for official-compatible Excalidraw MCP drawing into the live canvas, and use the media tools for image/video generation.'
    })
  }

  if (method === 'ping') return mcpResult(id, {})
  if (method === 'tools/list') return mcpResult(id, { tools: mcpToolDefinitions() })
  if (method === 'tools/call') {
    try {
      const result = await callLocalMcpTool(params?.name, params?.arguments ?? {})
      return mcpResult(id, result)
    } catch (error) {
      return mcpError(id, -32602, error instanceof Error ? error.message : String(error))
    }
  }

  if (id === undefined) return null
  return mcpError(id, -32601, `Method not found: ${method}`)
}

async function serveMcp(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname !== '/mcp') return false

  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('access-control-allow-headers', 'Content-Type, Accept, Authorization, Mcp-Session-Id')
  res.setHeader('access-control-expose-headers', 'Mcp-Session-Id')

  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return
  }

  if (req.method === 'GET') {
    sendJson(res, 200, {
      name: MCP_SERVER_NAME,
      version: MCP_SERVER_VERSION,
      endpoint: '/mcp',
      canvasUrl: `http://127.0.0.1:${defaultPort}/`,
      tools: mcpToolDefinitions().map((tool) => tool.name)
    })
    return
  }

  if (req.method === 'DELETE') {
    sendJson(res, 200, { ok: true })
    return
  }

  if (req.method !== 'POST') {
    res.statusCode = 405
    res.setHeader('allow', 'GET, POST, DELETE, OPTIONS')
    res.end()
    return
  }

  try {
    const body = JSON.parse(await readRequestBody(req))
    const response = Array.isArray(body)
      ? (await Promise.all(body.map((message) => handleMcpMessage(message)))).filter(Boolean)
      : await handleMcpMessage(body)

    if (!response) {
      res.statusCode = 202
      res.end()
      return
    }

    sendJson(res, 200, response)
  } catch (error) {
    sendJson(res, 400, mcpError(null, -32700, error instanceof Error ? error.message : String(error)))
  }

  return true
}

function canvasStoragePlugin() {
  return {
    name: 'codex-excalidraw-storage',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        try {
          if (await serveMcp(req, res)) return
          next()
        } catch (error) {
          sendJson(res, 500, { error: error.message })
        }
      })
      server.middlewares.use(serveCanvasAsset)
      server.watcher.add(canvasFile)
      let canvasWatchTimer = null
      server.watcher.on('change', (changedPath) => {
        if (resolve(changedPath) !== canvasFile) return
        clearTimeout(canvasWatchTimer)
        canvasWatchTimer = setTimeout(() => {
          broadcastCanvasChanged([canvasFile])
        }, 120)
      })

      server.middlewares.use('/api/canvas-events', (req, res) => {
        if (req.method !== 'GET') {
          res.statusCode = 405
          res.setHeader('allow', 'GET')
          res.end()
          return
        }

        res.statusCode = 200
        res.setHeader('content-type', 'text/event-stream')
        res.setHeader('cache-control', 'no-cache, no-transform')
        res.setHeader('connection', 'keep-alive')
        res.setHeader('x-accel-buffering', 'no')
        res.write(': connected\n\n')

        canvasEventClients.add(res)
        const heartbeat = setInterval(() => {
          res.write(`: heartbeat ${Date.now()}\n\n`)
        }, 25000)

        req.on('close', () => {
          clearInterval(heartbeat)
          canvasEventClients.delete(res)
        })
      })

      server.middlewares.use('/api/selection', async (req, res) => {
        try {
          if (req.method === 'GET') {
            try {
              sendJson(res, 200, {
                selection: await readJsonFile(selectionFile),
                path: selectionFile
              })
            } catch (error) {
              if (error.code === 'ENOENT') {
                sendJson(res, 200, {
                  selection: { selectedElements: [], selectedElementIds: [], updatedAt: null },
                  path: selectionFile
                })
                return
              }
              throw error
            }
            return
          }

          if (req.method === 'PUT') {
            const body = await readRequestBody(req)
            const selection = JSON.parse(body)
            if (!isSelectionState(selection)) {
              sendJson(res, 400, { error: 'Expected an Excalidraw selection state.' })
              return
            }

            await writeJsonAtomic(selectionFile, selection)
            sendJson(res, 200, { ok: true, path: selectionFile })
            return
          }

          res.statusCode = 405
          res.setHeader('allow', 'GET, PUT')
          res.end()
        } catch (error) {
          sendJson(res, 500, { error: error.message })
        }
      })

      server.middlewares.use('/api/view-state', async (req, res) => {
        try {
          if (req.method === 'GET') {
            try {
              sendJson(res, 200, {
                viewState: await readJsonFile(viewStateFile),
                path: viewStateFile
              })
            } catch (error) {
              if (error.code === 'ENOENT') {
                sendJson(res, 200, {
                  viewState: {
                    version: 1,
                    scrollX: 0,
                    scrollY: 0,
                    zoom: { value: 1 },
                    updatedAt: null
                  },
                  path: viewStateFile
                })
                return
              }
              throw error
            }
            return
          }

          if (req.method === 'PUT') {
            const body = await readRequestBody(req)
            const viewState = JSON.parse(body)
            if (!isViewState(viewState)) {
              sendJson(res, 400, { error: 'Expected an Excalidraw view state.' })
              return
            }

            await writeJsonAtomic(viewStateFile, viewState)
            sendJson(res, 200, { ok: true, path: viewStateFile })
            return
          }

          res.statusCode = 405
          res.setHeader('allow', 'GET, PUT')
          res.end()
        } catch (error) {
          sendJson(res, 500, { error: error.message })
        }
      })

      server.middlewares.use('/api/canvas', async (req, res) => {
        try {
          if (req.method === 'GET') {
            try {
              sendJson(res, 200, {
                scene: normalizeScene(await readJsonFile(canvasFile)),
                path: canvasFile,
                storage: 'single-file',
                assetsDir: canvasAssetsDir,
                assetsRoute: canvasAssetsRoute
              })
            } catch (error) {
              if (error.code === 'ENOENT') {
                sendJson(res, 200, {
                  scene: normalizeScene(null),
                  path: canvasFile,
                  storage: 'empty',
                  assetsDir: canvasAssetsDir,
                  assetsRoute: canvasAssetsRoute
                })
                return
              }
              throw error
            }
            return
          }

          if (req.method === 'PUT') {
            const body = await readRequestBody(req)
            const scene = normalizeScene(JSON.parse(body))
            if (!isScene(scene)) {
              sendJson(res, 400, { error: 'Expected an Excalidraw scene.' })
              return
            }

            await writeJsonAtomic(canvasFile, scene)
            sendJson(res, 200, { ok: true, path: canvasFile, storage: 'single-file' })
            broadcastCanvasChanged([canvasFile])
            return
          }

          res.statusCode = 405
          res.setHeader('allow', 'GET, PUT')
          res.end()
        } catch (error) {
          sendJson(res, 500, { error: error.message })
        }
      })

      server.middlewares.use('/api/generation-capabilities', async (req, res) => {
        if (req.method !== 'GET') {
          res.statusCode = 405
          res.setHeader('allow', 'GET')
          res.end()
          return
        }

        sendJson(res, 200, getGenerationCapabilities())
      })

      server.middlewares.use('/api/generate/image', async (req, res) => {
        try {
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.setHeader('allow', 'POST')
            res.end()
            return
          }

          const body = JSON.parse(await readRequestBody(req))
          const media = await generateImageMedia(body)
          const result = await insertExcalidrawImage({
            canvasDir,
            mediaBuffer: media.buffer,
            mimeType: media.mimeType,
            fileName: body.fileName || media.fileName,
            anchorElementId: body.anchorElementId,
            sourceElementId: body.sourceElementId,
            placement: body.placement,
            margin: body.margin,
            matchAnchor: body.matchAnchor,
            replaceAnchor: body.replaceAnchor,
            displayWidth: body.displayWidth,
            displayHeight: body.displayHeight,
            customData: {
              codexGeneratedImage: true,
              codexGenerationModel: media.model,
              codexGenerationPrompt: body.prompt,
              codexGenerationAspectRatio: body.aspectRatio ?? body.aspect_ratio,
              codexGenerationQuality: body.quality,
              generatorPrompt: body.prompt,
              generatorModel: body.model,
              generatorAspectRatio: body.aspectRatio ?? body.aspect_ratio,
              generatorImageQuality: body.quality,
              generatorImageSize: body.imageSize ?? body.size ?? '1K',
              codexGenerationSource: media.source,
              ...(body.customData && typeof body.customData === 'object' ? body.customData : {})
            }
          })

          sendJson(res, 200, {
            ok: true,
            kind: 'image',
            model: media.model,
            ...result
          })
          broadcastCanvasChanged([canvasFile, result.assetFile])
        } catch (error) {
          sendJson(res, 500, { error: error.message })
        }
      })

      server.middlewares.use('/api/generate/video', async (req, res) => {
        try {
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.setHeader('allow', 'POST')
            res.end()
            return
          }

          const body = JSON.parse(await readRequestBody(req))
          const media = await generateVideoMedia(body)
          const result = await insertExcalidrawVideo({
            canvasDir,
            mediaBuffer: media.buffer,
            mimeType: media.mimeType,
            fileName: body.fileName || media.fileName,
            anchorElementId: body.anchorElementId,
            sourceElementId: body.sourceElementId,
            placement: body.placement,
            margin: body.margin,
            matchAnchor: body.matchAnchor,
            replaceAnchor: body.replaceAnchor,
            displayWidth: body.displayWidth,
            displayHeight: body.displayHeight,
            aspectRatio: body.aspectRatio,
            duration: body.duration,
            prompt: body.prompt,
            model: media.model,
            customData: {
              codexGeneratedVideo: true,
              codexGenerationModel: media.model,
              codexGenerationPrompt: body.prompt,
              codexGenerationAspectRatio: body.aspectRatio ?? body.aspect_ratio,
              codexGenerationDuration: body.duration,
              codexGenerationResolution: body.resolution,
              videoPrompt: body.prompt,
              videoModel: body.model,
              videoAspectRatio: body.aspectRatio ?? body.aspect_ratio,
              videoDuration: body.duration,
              videoResolution: body.resolution,
              codexGenerationSource: media.source,
              ...(body.customData && typeof body.customData === 'object' ? body.customData : {})
            }
          })

          sendJson(res, 200, {
            ok: true,
            kind: 'video',
            model: media.model,
            ...result
          })
          broadcastCanvasChanged([canvasFile, result.assetFile])
        } catch (error) {
          sendJson(res, 500, { error: error.message })
        }
      })

      server.middlewares.use('/api/assets/copy', async (req, res) => {
        try {
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.setHeader('allow', 'POST')
            res.end()
            return
          }

          const body = JSON.parse(await readRequestBody(req))
          const sourcePath = resolve(String(body.sourcePath ?? ''))
          const requestedName = basename(String(body.fileName || basename(sourcePath) || 'asset'))
          const safeName = requestedName.replace(/[^a-zA-Z0-9._-]+/g, '-')
          const destinationPath = resolve(canvasAssetsDir, safeName)
          if (!isSafeChildPath(canvasAssetsDir, destinationPath)) {
            sendJson(res, 403, { error: 'Unsafe destination path.' })
            return
          }

          await mkdir(canvasAssetsDir, { recursive: true })
          await copyFile(sourcePath, destinationPath)
          sendJson(res, 200, {
            ok: true,
            path: destinationPath,
            url: `${canvasAssetsRoute}${encodeURIComponent(safeName)}`
          })
        } catch (error) {
          sendJson(res, 500, { error: error.message })
        }
      })
    }
  }
}

export default defineConfig({
  plugins: [react(), canvasStoragePlugin()],
  resolve: {
    alias: {
      'roughjs/bin/rough': resolve('node_modules/roughjs/bin/rough.js')
    }
  },
  server: {
    host: '127.0.0.1',
    port: defaultPort
  }
})
