import { TrackOpTypes, TriggerOpTypes } from './operations'
import { EMPTY_OBJ, isArray, isIntegerKey, isMap } from '@vue/shared'

// The main WeakMap that stores {target -> key -> dep} connections.
// Conceptually, it's easier to think of a dependency as a Dep class
// which maintains a Set of subscribers, but we simply store them as
// raw Sets to reduce memory overhead.
type Dep = Set<ReactiveEffect>
type KeyToDepMap = Map<any, Dep>
/*
    假设对象const obj = {a:1},并且是第一次添加
    targetMap.set(obj,new Map(obj.a,new Set()))
    obj做第一层map的key，obj.a做第二层map的key，dep为Set对象
*/
const targetMap = new WeakMap<any, KeyToDepMap>()

export interface ReactiveEffect<T = any> {
  (): T
  /*判断当前函数为ReactiveEffect函数*/
  _isEffect: true
  id: number
  active: boolean
  raw: () => T
  /*当前函数，反向的指向所依赖变量刚更新时的Dep。
     变量更新，查找dep，当前函数将被调用。
  * 作用：当前函数被清理时，清理掉dep中指向当前函数，避免空调用
  * */
  deps: Array<Dep>
  options: ReactiveEffectOptions
  allowRecurse: boolean
}

export interface ReactiveEffectOptions {
  lazy?: boolean
  scheduler?: (job: ReactiveEffect) => void
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void
  onStop?: () => void
  allowRecurse?: boolean
}

export type DebuggerEvent = {
  effect: ReactiveEffect
  target: object
  type: TrackOpTypes | TriggerOpTypes
  key: any
} & DebuggerEventExtraInfo

export interface DebuggerEventExtraInfo {
  newValue?: any
  oldValue?: any
  oldTarget?: Map<any, any> | Set<any>
}

const effectStack: ReactiveEffect[] = []
let activeEffect: ReactiveEffect | undefined

export const ITERATE_KEY = Symbol(__DEV__ ? 'iterate' : '')
export const MAP_KEY_ITERATE_KEY = Symbol(__DEV__ ? 'Map key iterate' : '')

/*判读函数类型为effect*/
export function isEffect(fn: any): fn is ReactiveEffect {
  return fn && fn._isEffect === true
}

/**
 *
 * @param fn 例子：instance.update = effect(function componentEffect() {}
 *
 * @param options
 */
export function effect<T = any>(
  fn: () => T,
  options: ReactiveEffectOptions = EMPTY_OBJ
): ReactiveEffect<T> {
  if (isEffect(fn)) {
    fn = fn.raw
  }
  const effect = createReactiveEffect(fn, options)
  if (!options.lazy) {
    effect()
  }
  return effect
}

/*暂停effect。清理相关变量dep的响应式更新*/
export function stop(effect: ReactiveEffect) {
  if (effect.active) {
    cleanup(effect)
    if (effect.options.onStop) {
      effect.options.onStop()
    }
    effect.active = false
  }
}

let uid = 0

/**/
function createReactiveEffect<T = any>(
  fn: () => T,
  options: ReactiveEffectOptions
): ReactiveEffect<T> {
  const effect = function reactiveEffect(): unknown {
    if (!effect.active) {
      return options.scheduler ? undefined : fn()
    }
    if (!effectStack.includes(effect)) {
      cleanup(effect)
      try {
        enableTracking()
        effectStack.push(effect)
        activeEffect = effect
        return fn()
      } finally {
        effectStack.pop()
        resetTracking()
        activeEffect = effectStack[effectStack.length - 1]
      }
    }
  } as ReactiveEffect
  effect.id = uid++
  effect.allowRecurse = !!options.allowRecurse
  effect._isEffect = true
  effect.active = true
  effect.raw = fn
  effect.deps = []
  effect.options = options
  return effect
}

/*清理相关变量dep的响应式更新*/
function cleanup(effect: ReactiveEffect) {
  const { deps } = effect
  if (deps.length) {
    for (let i = 0; i < deps.length; i++) {
      deps[i].delete(effect)
    }
    deps.length = 0
  }
}

let shouldTrack = true
const trackStack: boolean[] = []

/*暂停track，shouldTrack入栈，在赋值当前为false*/
export function pauseTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = false
}

/*开启一个新track，shouldTrack入栈，在赋值true*/
export function enableTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = true
}

/*出栈*/
export function resetTracking() {
  const last = trackStack.pop()
  shouldTrack = last === undefined ? true : last
}

export function track(target: object, type: TrackOpTypes, key: unknown) {
  if (!shouldTrack || activeEffect === undefined) {
    return
  }
  /*假设
  vue组件中，data的定义
  data() {
      return {
        count: {
          a:1
        }
      }
    },
  调用this.count.a触发当前函数
  target={a:1}
  key='a'
  这里 target=Map(target,Map(key,Set()))
  */
  /*1.获取target对应的map*/
  let depsMap = targetMap.get(target)
  if (!depsMap) {
    targetMap.set(target, (depsMap = new Map()))
  }
  /*2.获取target下key对应的set集合*/
  let dep = depsMap.get(key)
  if (!dep) {
    depsMap.set(key, (dep = new Set()))
  }
  if (!dep.has(activeEffect)) {
    /*activeEffect运行，触发对key的调用；key又添加activeEffect到自己的dep,dep是一个Set，*/
    /*key的赋值操作，proxy的set函数，将遍历该dep，触发effect，更新视图*/
    dep.add(activeEffect)

    /*activeEffect对应多个变量（例如a,b,c）的变化，当effect被清理时，需要从变量(a,b,c)的dep中清理当前effect。
    详情见function cleanup(effect: ReactiveEffect){}
    */
    /*所以activeEffect添加的是变量的依赖集合，方便后续循环在dep中删除自己（activeEffect）*/
    activeEffect.deps.push(dep)
    if (__DEV__ && activeEffect.options.onTrack) {
      activeEffect.options.onTrack({
        effect: activeEffect,
        target,
        type,
        key
      })
    }
  }
}

/*通过target从targetMap中获取到depsMap,
  在通过key从depsMap中获取deps
*
* */
export function trigger(
  target: object,
  type: TriggerOpTypes,
  key?: unknown,
  newValue?: unknown,
  oldValue?: unknown,
  oldTarget?: Map<unknown, unknown> | Set<unknown>
) {
  /* 以当前对象获取 依赖集合depsMap*/
  const depsMap = targetMap.get(target)
  if (!depsMap) {
    // never been tracked
    return
  }

  const effects = new Set<ReactiveEffect>()
  const add = (effectsToAdd: Set<ReactiveEffect> | undefined) => {
    if (effectsToAdd) {
      effectsToAdd.forEach(effect => {
        if (effect !== activeEffect || effect.allowRecurse) {
          effects.add(effect)
        }
      })
    }
  }

  if (type === TriggerOpTypes.CLEAR) {
    // collection being cleared
    // trigger all effects for target
    depsMap.forEach(add)
  } else if (key === 'length' && isArray(target)) {
    depsMap.forEach((dep, key) => {
      if (key === 'length' || key >= (newValue as number)) {
        add(dep)
      }
    })
  } else {
    // schedule runs for SET | ADD | DELETE
    if (key !== void 0) {
      /* 获取 当前依赖对象集合 具体key值的  依赖对象集合*/
      add(depsMap.get(key))
    }
    // also run for iteration key on ADD | DELETE | Map.SET
    /*存在key，add(depsMap.get(key))
    不存在key，但是target被调用了。target有可能是map对象。
    * 获取Symbol.iterator，添加到add(depsMap.get(Symbol.iterator))

     ？？？疑问，target怎么才能是map？？？
    * */
    switch (type) {
      case TriggerOpTypes.ADD:
        if (!isArray(target)) {
          add(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            add(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        } else if (isIntegerKey(key)) {
          // new index added to array -> length changes
          add(depsMap.get('length'))
        }
        break
      case TriggerOpTypes.DELETE:
        if (!isArray(target)) {
          add(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            add(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        }
        break
      case TriggerOpTypes.SET:
        /*疑问，target怎么才能是map*/
        if (isMap(target)) {
          add(depsMap.get(ITERATE_KEY))
        }
        break
    }
  }

  const run = (effect: ReactiveEffect) => {
    if (__DEV__ && effect.options.onTrigger) {
      effect.options.onTrigger({
        effect,
        target,
        key,
        type,
        newValue,
        oldValue,
        oldTarget
      })
    }
    if (effect.options.scheduler) {
      /* 调度触发*/
      effect.options.scheduler(effect)
    } else {
      effect()
    }
  }
  /*依次触发依赖集合中的函数*/
  effects.forEach(run)
}
