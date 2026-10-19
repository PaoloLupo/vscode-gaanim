from gaanim import Scene

import style

scene = Scene()
scene.segment("Welcome")
style.card(scene, "Kickoff")
scene.stop("hello")
scene.render()
