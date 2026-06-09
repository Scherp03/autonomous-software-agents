export const crateDomain = `
(define (domain default)
  (:requirements :strips :negative-preconditions)
  (:predicates 
    (left ?x1 ?x2) (right ?x1 ?x2)
    (up ?y1 ?y2) (down ?y1 ?y2)
    (agent ?x ?y)
    (wall ?x ?y)
    (crate ?x ?y)
  )
  (:action move-left
    :parameters (?x1 ?x2 ?y)
    :precondition (and (agent ?x1 ?y) (not (wall ?x2 ?y)) (not (crate ?x2 ?y)) (left ?x2 ?x1))
    :effect (and (agent ?x2 ?y) (not (agent ?x1 ?y)))
  )
  (:action move-right
    :parameters (?x1 ?x2 ?y)
    :precondition (and (agent ?x1 ?y) (not (wall ?x2 ?y)) (not (crate ?x2 ?y)) (right ?x2 ?x1))
    :effect (and (agent ?x2 ?y) (not (agent ?x1 ?y)))
  )
  (:action move-up
    :parameters (?x ?y1 ?y2)
    :precondition (and (agent ?x ?y1) (not (wall ?x ?y2)) (not (crate ?x ?y2)) (up ?y2 ?y1))
    :effect (and (agent ?x ?y2) (not (agent ?x ?y1)))
  )
  (:action move-down
    :parameters (?x ?y1 ?y2)
    :precondition (and (agent ?x ?y1) (not (wall ?x ?y2)) (not (crate ?x ?y2)) (down ?y2 ?y1))
    :effect (and (agent ?x ?y2) (not (agent ?x ?y1)))
  )
  (:action push-left
    :parameters (?x1 ?x2 ?x3 ?y)
    :precondition (and (agent ?x1 ?y) (crate ?x2 ?y) (not (wall ?x3 ?y)) (not (crate ?x3 ?y)) (left ?x2 ?x1) (left ?x3 ?x2))
    :effect (and (agent ?x2 ?y) (not (agent ?x1 ?y)) (crate ?x3 ?y) (not (crate ?x2 ?y)))
  )
  (:action push-right
    :parameters (?x1 ?x2 ?x3 ?y)
    :precondition (and (agent ?x1 ?y) (crate ?x2 ?y) (not (wall ?x3 ?y)) (not (crate ?x3 ?y)) (right ?x2 ?x1) (right ?x3 ?x2))
    :effect (and (agent ?x2 ?y) (not (agent ?x1 ?y)) (crate ?x3 ?y) (not (crate ?x2 ?y)))
  )
  (:action push-up
    :parameters (?x ?y1 ?y2 ?y3)
    :precondition (and (agent ?x ?y1) (crate ?x ?y2) (not (wall ?x ?y3)) (not (crate ?x ?y3)) (up ?y2 ?y1) (up ?y3 ?y2))
    :effect (and (agent ?x ?y2) (not (agent ?x ?y1)) (crate ?x ?y3) (not (crate ?x ?y2)))
  )
  (:action push-down
    :parameters (?x ?y1 ?y2 ?y3)
    :precondition (and (agent ?x ?y1) (crate ?x ?y2) (not (wall ?x ?y3)) (not (crate ?x ?y3)) (down ?y2 ?y1) (down ?y3 ?y2))
    :effect (and (agent ?x ?y2) (not (agent ?x ?y1)) (crate ?x ?y3) (not (crate ?x ?y2)))
  )
)`;