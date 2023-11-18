import { ref } from 'vue'
import type { Ref } from 'vue'

import type { ChampionSpellData, ChampionSpellMissileData } from '@tacticians-academy/academy-library'

import type { HexCoord } from '#/sim/helpers/types'

import type { ChampionUnit } from '#/sim/ChampionUnit'
import { GameEffect } from '#/sim/effects/GameEffect'
import type { AttackBounce, AttackEffectData } from '#/sim/effects/GameEffect'
import type { HexEffectData } from '#/sim/effects/HexEffect'

import { coordinateDistanceSquared, getCoordFrom, radiusToHexProportion } from '#/sim/helpers/board'
import { DEFAULT_CAST_SECONDS, HEX_PROPORTION, HEX_PROPORTION_PER_LEAGUEUNIT, SAFE_HEX_PROPORTION_PER_UPDATE, UNIT_SIZE_PROPORTION } from '#/sim/helpers/constants'
import { applyStackingModifier, getDistanceUnitOfTeam, getInteractableUnitsOfTeam, getNextBounceFrom } from '#/sim/helpers/effectUtils'
import type { DamageModifier } from '#/sim/helpers/types'

type TargetDeathAction = 'continue' | 'closestFromSource' | 'farthestFromSource' | 'closestFromTarget' | 'farthestFromTarget'

export interface ProjectileEffectData extends AttackEffectData {
	/** Delays activation of the `Projectile` until after reaching the target by this amount. */
	delayAfterReachingTargetMS?: DOMHighResTimeStamp
	/** Whether the `Projectile` should complete after the first time it collides with a unit. Set to false to apply to all intermediary units collided with. */
	destroysOnCollision?: boolean
	/** The fixed number of hexes this `Projectile` should travel, regardless of its target distance. */
	fixedHexRange?: number
	/** The damage modifier to stack per target hit. Requires `destroysOnCollision` to be false. */
	stackingDamageModifier?: DamageModifier
	/** Rotates the angle of the `Projectile`. Only works with `fixedHexRange`. */
	changeRadians?: number
	/** Only include if not passed with a `SpellCalculation`. */
	missile?: ChampionSpellMissileData
	/** Custom missile width */
	width?: number
	/** Defaults to the source unit's attack target unit, or the unit's hex at cast time if `fixedHexRange` is set. */
	target?: ChampionUnit | HexCoord
	/** Origin point for the Projectile. Defaults to the queuing source. */
	projectileStartsFrom?: ChampionUnit | HexCoord
	/** Creates a `HexEffect` upon completion. */
	hexEffect?: HexEffectData
	/** If the `Projectile` should retarget a new unit upon death of the original target. Only works when `target` is a ChampionUnit. */
	targetDeathAction?: TargetDeathAction
	/** Optional missile data for the `Projectile` to use if it should return to its source. */
	returnMissile?: ChampionSpellMissileData
	/** If the projectile should display its path. */
	hasBackingVisual?: boolean
}

function isUnit(target: ChampionUnit | HexCoord): target is ChampionUnit {
	return 'data' in target
}

export class ProjectileEffect extends GameEffect {
	coord: Ref<HexCoord>
	missile: ChampionSpellMissileData
	currentSpeed = 0
	target: ChampionUnit | HexCoord
	projectileStartsFrom: ChampionUnit | HexCoord
	targetCoord: HexCoord
	hexEffect: HexEffectData | undefined
	destroysOnCollision: boolean | undefined
	stackingDamageModifier: DamageModifier | undefined
	targetDeathAction: TargetDeathAction | undefined
	returnMissile: ChampionSpellMissileData | undefined
	isReturning = false
	bounce: AttackBounce | undefined
	delayAfterReachingTargetMS: DOMHighResTimeStamp | undefined

	width = 0
	collisionRadiusSquared = 0

	traveledDistance = 0
	maxDistance: number | undefined
	fixedDeltaX: number | undefined
	fixedDeltaY: number | undefined

	constructor(source: ChampionUnit, elapsedMS: DOMHighResTimeStamp, spell: ChampionSpellData | undefined, data: ProjectileEffectData) {
		if (!data.target || !data.missile) throw 'Target must be provided'
		super(source, spell, data)

		const startsAfterMS = data.startsAfterMS != null ? data.startsAfterMS : (spell ? (spell.castTime ?? DEFAULT_CAST_SECONDS) * 1000 : 0)
		const startDelay = spell?.missile?.startDelay
		this.startsAtMS = elapsedMS + startsAfterMS + (startDelay != null ? startDelay * 1000 : 0)
		this.activatesAfterMS = 0
		this.activatesAtMS = this.startsAtMS + this.activatesAfterMS
		this.expiresAtMS = data.expiresAfterMS != null ? data.expiresAfterMS : undefined

		this.projectileStartsFrom = data.projectileStartsFrom ?? source
		this.coord = ref([...('coord' in this.projectileStartsFrom ? this.projectileStartsFrom.coord : getCoordFrom(this.projectileStartsFrom))] as HexCoord) // Destructure to avoid mutating source
		this.missile = data.missile
		if (data.width != null) {
			this.width = radiusToHexProportion(data.width)
		}
		this.target = data.target
		this.targetCoord = [0, 0]
		this.setTarget(data.target)
		this.resetSpeed()
		this.hexEffect = data.hexEffect
		this.destroysOnCollision = data.destroysOnCollision
		this.stackingDamageModifier = data.stackingDamageModifier
		this.targetDeathAction = data.targetDeathAction
		this.returnMissile = data.returnMissile
		this.bounce = data.bounce
		this.delayAfterReachingTargetMS = data.delayAfterReachingTargetMS
		if (this.bounce && isUnit(this.target)) {
			this.bounce.hitUnits = [this.target]
		}

		if (data.fixedHexRange != null) {
			const [deltaX, deltaY] = this.getDelta(this.targetCoord, data.changeRadians)
			this.fixedDeltaX = deltaX
			this.fixedDeltaY = deltaY
			this.maxDistance = data.fixedHexRange * HEX_PROPORTION
			this.targetCoord = [this.coord.value[0] + deltaX * this.maxDistance, this.coord.value[1] + deltaY * this.maxDistance]
		}

		this.updateWidth()
	}

	updateWidth() {
		if (this.missile.width != null) {
			this.width = radiusToHexProportion(this.missile.width)
		}
		const collisionRadius = (this.width + UNIT_SIZE_PROPORTION) / 2
		this.collisionRadiusSquared = collisionRadius * collisionRadius
	}

	getDelta(targetCoord?: HexCoord, changeRadians?: number) {
		const [currentX, currentY] = this.coord.value
		const [targetX, targetY] = targetCoord ?? this.targetCoord
		const distanceX = targetX - currentX
		const distanceY = targetY - currentY
		const angle = Math.atan2(distanceY, distanceX) + (changeRadians ?? 0)
		return [Math.cos(angle), Math.sin(angle), distanceX, distanceY]
	}

	apply = (elapsedMS: DOMHighResTimeStamp, unit: ChampionUnit, isFinalTarget: boolean) => {
		const wasSpellShielded = this.applySuper(elapsedMS, unit)
		if (!wasSpellShielded && isFinalTarget) {
			if (this.hexEffect) {
				if (this.hexEffect.hexDistanceFromSource != null) {
					this.hexEffect.hexSource = unit
				}
				this.source.queueHexEffect(elapsedMS, undefined, this.hexEffect)
			}
			const bounce = this.bounce
			if (bounce) {
				const bounceTarget = getNextBounceFrom(this.target as ChampionUnit, bounce)
				if (bounceTarget) {
					if (this.damageModifier) {
						Object.assign(this.damageModifier, bounce.damageModifier)
					} else {
						this.damageModifier = this.bounce?.damageModifier
					}
					if (bounce.damageCalculation) {
						this.damageCalculation = bounce.damageCalculation
					}
					bounce.bouncesRemaining -= 1
					this.setTarget(bounceTarget)
					return false
				}
			}
		}
		return true
	}

	resetSpeed() {
		if (this.missile.speedInitial != null) {
			this.currentSpeed = this.missile.speedInitial
		} else if (this.missile.travelTime != null) {
			this.currentSpeed = this.source.getSpeedForTravelTime(this.missile.travelTime * 1000, this.target)
		} else {
			console.error('Unknown speed for missile', this)
		}
	}

	checkIfDies(elapsedMS: DOMHighResTimeStamp) {
		const returnIDSuffix = 'Returns'
		if (this.returnMissile) {
			if (!this.isReturning) {
				this.maxDistance = undefined
				this.setTarget(this.projectileStartsFrom)
				this.missile = this.returnMissile
				this.updateWidth()
				this.opacity = 0.5
				this.resetSpeed()
				this.instanceID += returnIDSuffix
				this.hitID += returnIDSuffix //TODO if damage is unique to outward direction
				this.isReturning = true
				return true
			}
			this.onCollided?.(elapsedMS, this, this.source)
		}
		if (this.delayAfterReachingTargetMS != null && isUnit(this.target)) {
			if (this.expiresAtMS == null) {
				this.expiresAtMS = elapsedMS + this.delayAfterReachingTargetMS
			}
			return true
		}
		return false
	}

	setTarget(target: ChampionUnit | HexCoord) {
		this.target = target
		this.targetCoord = isUnit(target) ? target.coord : getCoordFrom(target)
		if (this.hexEffect?.hexSource) {
			this.hexEffect.hexSource = this.target
		}
	}

	checkDelayCollision(elapsedMS: DOMHighResTimeStamp) {
		if (this.delayAfterReachingTargetMS != null && this.expiresAtMS != null && isUnit(this.target)) {
			this.onCollided?.(elapsedMS, this, this.target)
		}
	}

	intersects = (unit: ChampionUnit) => {
		return coordinateDistanceSquared(this.coord.value, unit.coord) < this.collisionRadiusSquared
	}

	update = (elapsedMS: DOMHighResTimeStamp, diffMS: DOMHighResTimeStamp, units: ChampionUnit[]) => {
		const updateResult = this.updateSuper(elapsedMS)
		if (updateResult != null) {
			if (!updateResult) {
				this.checkDelayCollision(elapsedMS)
			}
			return updateResult
		}

		if (isUnit(this.target)) {
			if (this.target.dead) {
				if (this.targetDeathAction == null) {
					this.checkDelayCollision(elapsedMS)
					return false
				}
				if (this.targetDeathAction === 'continue') {
					this.setTarget(this.target.activeHex)
				} else {
					const distanceFromUnit = this.targetDeathAction.endsWith('Target') ? this.target : this.source
					const newTarget = getDistanceUnitOfTeam(this.targetDeathAction.startsWith('farthest'), distanceFromUnit, this.target.team)
					if (newTarget) {
						this.setTarget(newTarget)
					} else {
						return false
					}
				}
			} else {
				this.targetCoord = this.target.coord
			}
		}

		const totalDistanceForUpdate = diffMS / 1000 * this.currentSpeed * HEX_PROPORTION_PER_LEAGUEUNIT
		let angleX, angleY
		if (this.maxDistance != null) {
			angleX = this.fixedDeltaX!
			angleY = this.fixedDeltaY!
		} else {
			const [deltaX, deltaY, distanceX, distanceY] = this.getDelta()
			if (Math.abs(distanceX) <= totalDistanceForUpdate && Math.abs(distanceY) <= totalDistanceForUpdate) {
				if (!this.isReturning && isUnit(this.target) && !this.collidedWith.includes(this.target.instanceID)) {
					if (this.apply(elapsedMS, this.target, true) === false) {
						return true
					}
				}
				return this.checkIfDies(elapsedMS)
			}
			angleX = deltaX
			angleY = deltaY
		}

		const checksForUpdate = Math.ceil(totalDistanceForUpdate / SAFE_HEX_PROPORTION_PER_UPDATE)
		if (checksForUpdate > 1) {
			console.log('checksForUpdate', this.source.data.name, checksForUpdate)
		}
		const diffDistance = totalDistanceForUpdate / checksForUpdate
		for (let check = 1; check <= checksForUpdate; check += 1) {
			if (this.destroysOnCollision != null && this.targetTeam !== undefined) {
				for (const unit of getInteractableUnitsOfTeam(this.targetTeam)) {
					if (!this.collidedWith.includes(unit.instanceID) && this.intersects(unit)) {
						if (this.apply(elapsedMS, unit, this.destroysOnCollision) === true) {
							if (this.destroysOnCollision) {
								return this.checkIfDies(elapsedMS)
							}
							if (this.stackingDamageModifier) {
								if (!this.damageModifier) {
									this.damageModifier = {}
								}
								applyStackingModifier(this.damageModifier, this.stackingDamageModifier)
							}
						}
					}
				}
			}

			if (this.maxDistance != null) {
				this.traveledDistance += diffDistance
				if (this.traveledDistance >= this.maxDistance) {
					if (!this.isReturning && isUnit(this.target)) {
						if (this.apply(elapsedMS, this.target, true) === false) {
							return true
						}
					}
					return this.checkIfDies(elapsedMS)
				}
			}
			const position = this.coord.value
			position[0] += angleX * diffDistance
			position[1] += angleY * diffDistance
		}

		if (this.missile.acceleration != null) {
			this.currentSpeed = this.currentSpeed + this.missile.acceleration * diffMS / 1000 //TODO experimentally determine
			if (this.missile.acceleration > 0) {
				if (this.missile.speedMax != null && this.currentSpeed > this.missile.speedMax) {
					this.currentSpeed = this.missile.speedMax
				}
			} else {
				if (this.missile.speedMin != null && this.currentSpeed < this.missile.speedMin) {
					this.currentSpeed = this.missile.speedMin
				}
			}
		}
	}
}
