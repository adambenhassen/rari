if (!globalThis['~rari'])
  globalThis['~rari'] = {}

const FILE_URL_REGEX = /^file:\/\/.*\/app\//
const JS_EXTENSION_REGEX = /\.js$/

globalThis['~rari'].metadataCollector = {
  async collect(layoutPaths, pagePath, params, searchParams, pageProps) {
    const metadataList = []
    const routeProps = { params, searchParams }

    async function extractMetadata(modulePath, props) {
      try {
        if (globalThis['~rsc'] && typeof globalThis['~rsc'].modules !== 'undefined') {
          const moduleKey = modulePath.replace(FILE_URL_REGEX, 'app/').replace(JS_EXTENSION_REGEX, '')

          const module = globalThis['~rsc'].modules[moduleKey]

          if (module) {
            if (typeof module.generateMetadata === 'function') {
              const result = await module.generateMetadata(props)
              if (result && typeof result === 'object')
                return result
            }

            if (module.metadata && typeof module.metadata === 'object')
              return module.metadata
          }
        }

        const module = await import(modulePath)

        if (typeof module.generateMetadata === 'function') {
          const result = await module.generateMetadata(props)
          if (result && typeof result === 'object')
            return result
        }

        if (module.metadata && typeof module.metadata === 'object')
          return module.metadata

        return {}
      }
      catch (error) {
        console.error(`Failed to extract metadata from ${modulePath}:`, error)
        return {}
      }
    }

    const validLayoutPaths = Array.isArray(layoutPaths) ? layoutPaths : []
    for (const layoutPath of validLayoutPaths) {
      const layoutMetadata = await extractMetadata(layoutPath, routeProps)
      metadataList.push(layoutMetadata)
    }

    const pageMetadata = await extractMetadata(pagePath, pageProps || routeProps)
    metadataList.push(pageMetadata)

    return metadataList
  },
}
