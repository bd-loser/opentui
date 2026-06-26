import { template, types as t, type PluginObj } from "@babel/core"
import { decodeHTMLStrict } from "entities"

function decodeRawEntities(raw: string): string {
  const expression = template.expression.ast(raw)
  return t.isStringLiteral(expression) ? JSON.stringify(decodeHTMLStrict(expression.value)) : raw
}

export default function decodeStaticTextProperties(): PluginObj {
  return {
    visitor: {
      Program(path) {
        path.traverse({
          JSXAttribute(attributePath) {
            const attribute = attributePath.node
            const element = attributePath.parentPath.node
            if (!t.isJSXIdentifier(attribute.name) || !t.isStringLiteral(attribute.value)) return
            if (attribute.name.name !== "text" && attribute.name.name !== "content") return
            if (!t.isJSXOpeningElement(element) || !t.isJSXIdentifier(element.name)) return
            if (element.name.name[0] !== element.name.name[0]?.toLowerCase()) return

            if (typeof attribute.value.extra?.raw === "string") {
              attribute.value.extra.raw = decodeRawEntities(attribute.value.extra.raw)
            }
          },
        })
      },
    },
  }
}
