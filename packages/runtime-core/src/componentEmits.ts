import {
  camelize,
  EMPTY_OBJ,
  toHandlerKey,
  extend,
  hasOwn,
  hyphenate,
  isArray,
  isFunction,
  isOn,
  toNumber
} from '@vue/shared'
import {
  ComponentInternalInstance,
  ComponentOptions,
  ConcreteComponent,
  formatComponentName
} from './component'
import { callWithAsyncErrorHandling, ErrorCodes } from './errorHandling'
import { warn } from './warning'
import { UnionToIntersection } from './helpers/typeUtils'
import { devtoolsComponentEmit } from './devtools'
import { AppContext } from './apiCreateApp'

export type ObjectEmitsOptions = Record<
  string,
  ((...args: any[]) => any) | null
>
export type EmitsOptions = ObjectEmitsOptions | string[]

export type EmitFn<
  Options = ObjectEmitsOptions,
  Event extends keyof Options = keyof Options
> = Options extends Array<infer V>
  ? (event: V, ...args: any[]) => void
  : {} extends Options // if the emit is empty object (usually the default value for emit) should be converted to function
    ? (event: string, ...args: any[]) => void
    : UnionToIntersection<
        {
          [key in Event]: Options[key] extends ((...args: infer Args) => any)
            ? (event: key, ...args: Args) => void
            : (event: key, ...args: any[]) => void
        }[Event]
      >

export function emit(
  instance: ComponentInternalInstance,
  event: string,
  ...rawArgs: any[]
) {
  const props = instance.vnode.props || EMPTY_OBJ

  if (__DEV__) {
    const {
      emitsOptions,
      propsOptions: [propsOptions]
    } = instance
    if (emitsOptions) {
      if (!(event in emitsOptions)) {
        if (!propsOptions || !(toHandlerKey(event) in propsOptions)) {
          warn(
            `Component emitted event "${event}" but it is neither declared in ` +
              `the emits option nor as an "${toHandlerKey(event)}" prop.`
          )
        }
      } else {
        const validator = emitsOptions[event]
        if (isFunction(validator)) {
          const isValid = validator(...rawArgs)
          if (!isValid) {
            warn(
              `Invalid event arguments: event validation failed for event "${event}".`
            )
          }
        }
      }
    }
  }

  let args = rawArgs
  const isModelListener = event.startsWith('update:')

  // for v-model update:xxx events, apply modifiers on args
  const modelArg = isModelListener && event.slice(7)
  if (modelArg && modelArg in props) {
    const modifiersKey = `${
      modelArg === 'modelValue' ? 'model' : modelArg
    }Modifiers`
    const { number, trim } = props[modifiersKey] || EMPTY_OBJ
    if (trim) {
      args = rawArgs.map(a => a.trim())
    } else if (number) {
      args = rawArgs.map(toNumber)
    }
  }

  if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
    devtoolsComponentEmit(instance, event, args)
  }

  if (__DEV__) {
    const lowerCaseEvent = event.toLowerCase()
    if (lowerCaseEvent !== event && props[toHandlerKey(lowerCaseEvent)]) {
      warn(
        `Event "${lowerCaseEvent}" is emitted in component ` +
          `${formatComponentName(
            instance,
            instance.type
          )} but the handler is registered for "${event}". ` +
          `Note that HTML attributes are case-insensitive and you cannot use ` +
          `v-on to listen to camelCase events when using in-DOM templates. ` +
          `You should probably use "${hyphenate(event)}" instead of "${event}".`
      )
    }
  }

  // convert handler name to camelCase. See issue #2249
  let handlerName = toHandlerKey(camelize(event))
  let handler = props[handlerName]
  // for v-model update:xxx events, also trigger kebab-case equivalent
  // for props passed via kebab-case
  if (!handler && isModelListener) {
    handlerName = toHandlerKey(hyphenate(event))
    handler = props[handlerName]
  }

  if (handler) {
    callWithAsyncErrorHandling(
      handler,
      instance,
      ErrorCodes.COMPONENT_EVENT_HANDLER,
      args
    )
  }

  const onceHandler = props[handlerName + `Once`]
  if (onceHandler) {
    if (!instance.emitted) {
      ;(instance.emitted = {} as Record<string, boolean>)[handlerName] = true
    } else if (instance.emitted[handlerName]) {
      return
    }
    callWithAsyncErrorHandling(
      onceHandler,
      instance,
      ErrorCodes.COMPONENT_EVENT_HANDLER,
      args
    )
  }
}

export function normalizeEmitsOptions(
  comp: ConcreteComponent,
  appContext: AppContext,
  asMixin = false
): ObjectEmitsOptions | null {
  if (!appContext.deopt && comp.__emits !== undefined) {
    return comp.__emits
  }

  const raw = comp.emits
  let normalized: ObjectEmitsOptions = {}

  // apply mixin/extends props
  let hasExtends = false
  if (__FEATURE_OPTIONS_API__ && !isFunction(comp)) {
    const extendEmits = (raw: ComponentOptions) => {
      hasExtends = true
      extend(normalized, normalizeEmitsOptions(raw, appContext, true))
    }
    if (!asMixin && appContext.mixins.length) {
      appContext.mixins.forEach(extendEmits)
    }
    if (comp.extends) {
      extendEmits(comp.extends)
    }
    if (comp.mixins) {
      comp.mixins.forEach(extendEmits)
    }
  }

  if (!raw && !hasExtends) {
    return (comp.__emits = null)
  }

  if (isArray(raw)) {
    raw.forEach(key => (normalized[key] = null))
  } else {
    extend(normalized, raw)
  }
  return (comp.__emits = normalized)
}

// Check if an incoming prop key is a declared emit event listener.
// e.g. With `emits: { click: null }`, props named `onClick` and `onclick` are
// both considered matched listeners.
export function isEmitListener(
  options: ObjectEmitsOptions | null,
  key: string
): boolean {
  if (!options || !isOn(key)) {
    return false
  }
  key = key.replace(/Once$/, '')
  return (
    hasOwn(options, key[2].toLowerCase() + key.slice(3)) ||
    hasOwn(options, key.slice(2))
  )
}