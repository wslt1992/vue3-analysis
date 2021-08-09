import {
  reactive,
  readonly,
  toRaw,
  ReactiveFlags,
  Target,
  readonlyMap,
  reactiveMap
} from './reactive'
import { TrackOpTypes, TriggerOpTypes } from './operations'
import {
  track,
  trigger,
  ITERATE_KEY,
  pauseTracking,
  resetTracking
} from './effect'
import {
  isObject,
  hasOwn,
  isSymbol,
  hasChanged,
  isArray,
  isIntegerKey,
  extend
} from '@vue/shared'
import { isRef } from './ref'

const builtInSymbols = new Set(
  Object.getOwnPropertyNames(Symbol)
    .map(key => (Symbol as any)[key])
    .filter(isSymbol)
)
/*普通的get*/
const get = /*#__PURE__*/ createGetter()
/*数据变化只监听一层的get*/
const shallowGet = /*#__PURE__*/ createGetter(false, true)
/*只读get*/
const readonlyGet = /*#__PURE__*/ createGetter(true)
/*一层并只读get*/
const shallowReadonlyGet = /*#__PURE__*/ createGetter(true, true)

const arrayInstrumentations: Record<string, Function> = {}
// instrument identity-sensitive Array methods to account for possible reactive
// values
;(['includes', 'indexOf', 'lastIndexOf'] as const).forEach(key => {
  const method = Array.prototype[key] as any
  arrayInstrumentations[key] = function(this: unknown[], ...args: unknown[]) {
    const arr = toRaw(this)
    for (let i = 0, l = this.length; i < l; i++) {
      track(arr, TrackOpTypes.GET, i + '')
    }
    // we run the method using the original args first (which may be reactive)
    const res = method.apply(arr, args)
    if (res === -1 || res === false) {
      // if that didn't work, run it again using raw values.
      return method.apply(arr, args.map(toRaw))
    } else {
      return res
    }
  }
})
// instrument length-altering mutation methods to avoid length being tracked
// which leads to infinite loops in some cases (#2137)
;(['push', 'pop', 'shift', 'unshift', 'splice'] as const).forEach(key => {
  const method = Array.prototype[key] as any
  arrayInstrumentations[key] = function(this: unknown[], ...args: unknown[]) {
    pauseTracking()
    const res = method.apply(this, args)
    resetTracking()
    return res
  }
})

function createGetter(isReadonly = false, shallow = false) {
  /* 调用的为对象特殊key，直接返回值*/
  return function get(target: Target, key: string | symbol, receiver: object) {
    if (key === ReactiveFlags.IS_REACTIVE) {
      return !isReadonly
    } else if (key === ReactiveFlags.IS_READONLY) {
      return isReadonly
    } else if (
      key === ReactiveFlags.RAW &&
      receiver === (isReadonly ? readonlyMap : reactiveMap).get(target)
    ) {
      return target
    }

    const targetIsArray = isArray(target)
    if (targetIsArray && hasOwn(arrayInstrumentations, key)) {
      return Reflect.get(arrayInstrumentations, key, receiver)
    }

    /*获取target[key]的值*/
    const res = Reflect.get(target, key, receiver)

    if (
      isSymbol(key)
        ? builtInSymbols.has(key as symbol)
        : key === `__proto__` || key === `__v_isRef`
    ) {
      return res
    }

    /*如果是只读，则不进行track。
    * 只读无法被修改，也不需要track
    * */
    if (!isReadonly) {
      track(target, TrackOpTypes.GET, key)
    }

    /*shallow，直接返回数据。*/
    if (shallow) {
      return res
    }

    if (isRef(res)) {
      // ref unwrapping - does not apply for Array + integer key.
      const shouldUnwrap = !targetIsArray || !isIntegerKey(key)
      return shouldUnwrap ? res.value : res
    }

    if (isObject(res)) {
      // Convert returned value into a proxy as well. we do the isObject check
      // here to avoid invalid value warning. Also need to lazy access readonly
      // and reactive here to avoid circular dependency.
      /*返回值是一个对象，内部属性也需要相同的处理。
      * 如果当前有readonly标记，内层也需要只读处理。（递归只读处理）
      * 非readonly，进行响应式处理。不同于const只防止自己被赋值，而不能防止属性被改变；
      * readonly可以防止自己和内部属性的变化；
      * readonly也不会进行track()处理。假设进行track处理，而readonly不会变化，处理无意义
      * */
      return isReadonly ? readonly(res) : reactive(res)
    }

    return res
  }
}

const set = /*#__PURE__*/ createSetter()
const shallowSet = /*#__PURE__*/ createSetter(true)

function createSetter(shallow = false) {
  return function set(
    target: object,
    key: string | symbol,
    value: unknown,
    receiver: object
  ): boolean {
    const oldValue = (target as any)[key]
    if (!shallow) {
      value = toRaw(value)
      if (!isArray(target) && isRef(oldValue) && !isRef(value)) {
        oldValue.value = value
        return true
      }
    } else {
      // in shallow mode, objects are set as-is regardless of reactive or not
    }

    /*1.如果是数组并key为number类型；判断key<length
    * 2.判断target是否存在key
    * */
    const hadKey =
      isArray(target) && isIntegerKey(key)
        ? Number(key) < target.length
        : hasOwn(target, key)
    const result = Reflect.set(target, key, value, receiver)
    // don't trigger if target is something up in the prototype chain of original
    /* 对象原型链指向了proxy，此时receiver不是target的proxy。receiver、target是同一个对象
    * const proxy = new Proxy({}, {
      get: function(target, property, receiver) {
        return receiver;
      }
    });

    const d = Object.create(proxy);
    d.a === d // true
    //d对象本身没有a属性，所以读取d.a的时候，会去d的原型proxy对象找。这时，receiver就指向d，代表原始的读操作所在的那个对象。
    原文链接：https://blog.csdn.net/gercke/article/details/103228737
    * */
    if (target === toRaw(receiver)) {
      if (!hadKey) {
        trigger(target, TriggerOpTypes.ADD, key, value)
      } else if (hasChanged(value, oldValue)) {
        /*触发关联 依赖*/
        trigger(target, TriggerOpTypes.SET, key, value, oldValue)
      }
    }
    return result
  }
}

function deleteProperty(target: object, key: string | symbol): boolean {
  const hadKey = hasOwn(target, key)
  const oldValue = (target as any)[key]
  const result = Reflect.deleteProperty(target, key)
  if (result && hadKey) {
    trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
  }
  return result
}

function has(target: object, key: string | symbol): boolean {
  const result = Reflect.has(target, key)
  if (!isSymbol(key) || !builtInSymbols.has(key)) {
    track(target, TrackOpTypes.HAS, key)
  }
  return result
}

function ownKeys(target: object): (string | number | symbol)[] {
  track(target, TrackOpTypes.ITERATE, isArray(target) ? 'length' : ITERATE_KEY)
  return Reflect.ownKeys(target)
}

export const mutableHandlers: ProxyHandler<object> = {
  get,
  set,
  deleteProperty,
  has,
  ownKeys
}

export const readonlyHandlers: ProxyHandler<object> = {
  get: readonlyGet,
  set(target, key) {
    if (__DEV__) {
      console.warn(
        `Set operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  },
  deleteProperty(target, key) {
    if (__DEV__) {
      console.warn(
        `Delete operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  }
}

export const shallowReactiveHandlers: ProxyHandler<object> = extend(
  {},
  mutableHandlers,
  {
    get: shallowGet,
    set: shallowSet
  }
)

// Props handlers are special in the sense that it should not unwrap top-level
// refs (in order to allow refs to be explicitly passed down), but should
// retain the reactivity of the normal readonly object.
export const shallowReadonlyHandlers: ProxyHandler<object> = extend(
  {},
  readonlyHandlers,
  {
    get: shallowReadonlyGet
  }
)
