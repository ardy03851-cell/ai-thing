/* =========================================================
   CAMERA.JS
   Player movement + look controls (desktop mouse / iPad touch).

   Improvements over the original:
     - look input is smoothed (low-pass filtered) instead of
       applied raw, so mouse/touch look feels weighty and
       cinematic instead of twitchy
     - movement has acceleration/deceleration instead of an
       instant speed snap, so starting/stopping feels grounded
     - a very subtle head-bob is added while moving, driven by
       a sine wave tied to distance traveled (not just time), so
       it speeds up/slows down naturally with player speed
     - run is a smooth speed blend, not an instant snap
========================================================= */

window.PlayerCamera = (function(){

  let camera = null;
  let CONFIG = null;

  const player = {
    pos: new THREE.Vector3(0, 1.7, 0),
  };

  let yaw = 0, pitch = 0;
  let yawTarget = 0, pitchTarget = 0;

  let isTouch = false;
  let pointerLocked = false;
  const keys = {};

  // joystick state
  let moveTouchId = null;
  let moveOrigin = { x: 0, y: 0 };
  let moveVec = { x: 0, y: 0 };
  let lookTouchId = null;
  let lookLast = { x: 0, y: 0 };
  let running = false;

  // smoothed movement speed (for accel/decel feel)
  let currentSpeed = 0;

  // head-bob state
  let bobDistance = 0;
  let bobAmount = 0;

  let onFlashlightToggle = null;

  function init(threeCamera, config, flashlightToggleCallback){
    camera = threeCamera;
    CONFIG = config;
    onFlashlightToggle = flashlightToggleCallback;

    isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;

    window.addEventListener('keydown', e => {
      keys[e.code] = true;
      if(e.code === 'KeyF') onFlashlightToggle && onFlashlightToggle();
    });
    window.addEventListener('keyup', e => { keys[e.code] = false; });

    document.addEventListener('pointerlockchange', () => {
      pointerLocked = !!document.pointerLockElement;
    });

    document.addEventListener('mousemove', e => {
      if(!pointerLocked || window.__gameIsDead) return;
      yawTarget -= e.movementX * CONFIG.lookSensitivity;
      pitchTarget -= e.movementY * CONFIG.lookSensitivity;
      pitchTarget = Math.max(-1.2, Math.min(1.2, pitchTarget));
    });

    if(isTouch){
      document.getElementById('touchControls').classList.add('active');
      document.getElementById('desktopHint').style.display = 'none';
      setupTouchJoystick();
      setupTouchLook();
      setupTouchButtons();
    }

    camera.position.copy(player.pos);
  }

  function requestLock(domElement){
    if(!isTouch) domElement.requestPointerLock();
  }

  function bindClickToLock(domElement, canLockFn){
    domElement.addEventListener('click', () => {
      if(!isTouch && canLockFn()) domElement.requestPointerLock();
    });
  }

  /* ---------------------------------------------------------
     TOUCH CONTROLS
  --------------------------------------------------------- */
  function setupTouchJoystick(){
    const zone = document.getElementById('moveZone');
    const base = document.getElementById('joystickBase');
    const thumb = document.getElementById('joystickThumb');
    const maxRadius = 50;

    zone.addEventListener('touchstart', e => {
      const t = e.changedTouches[0];
      moveTouchId = t.identifier;
      moveOrigin.x = t.clientX;
      moveOrigin.y = t.clientY;
      base.style.left = (t.clientX - 55) + 'px';
      base.style.top = (t.clientY - 55) + 'px';
      base.style.display = 'block';
      thumb.style.left = '50%';
      thumb.style.top = '50%';
    }, { passive: true });

    zone.addEventListener('touchmove', e => {
      for(const t of e.changedTouches){
        if(t.identifier !== moveTouchId) continue;
        const dx = t.clientX - moveOrigin.x;
        const dy = t.clientY - moveOrigin.y;
        const dist = Math.min(maxRadius, Math.hypot(dx, dy));
        const ang = Math.atan2(dy, dx);
        const cx = Math.cos(ang) * dist;
        const cy = Math.sin(ang) * dist;
        thumb.style.left = (55 + cx) + 'px';
        thumb.style.top = (55 + cy) + 'px';
        moveVec.x = cx / maxRadius;
        moveVec.y = cy / maxRadius;
      }
    }, { passive: true });

    function endMove(e){
      for(const t of e.changedTouches){
        if(t.identifier !== moveTouchId) continue;
        moveTouchId = null;
        moveVec.x = 0; moveVec.y = 0;
        base.style.display = 'none';
      }
    }
    zone.addEventListener('touchend', endMove, { passive: true });
    zone.addEventListener('touchcancel', endMove, { passive: true });
  }

  function setupTouchLook(){
    const zone = document.getElementById('lookZone');

    zone.addEventListener('touchstart', e => {
      const t = e.changedTouches[0];
      lookTouchId = t.identifier;
      lookLast.x = t.clientX;
      lookLast.y = t.clientY;
    }, { passive: true });

    zone.addEventListener('touchmove', e => {
      for(const t of e.changedTouches){
        if(t.identifier !== lookTouchId) continue;
        const dx = t.clientX - lookLast.x;
        const dy = t.clientY - lookLast.y;
        lookLast.x = t.clientX;
        lookLast.y = t.clientY;
        yawTarget -= dx * CONFIG.touchLookSensitivity;
        pitchTarget -= dy * CONFIG.touchLookSensitivity;
        pitchTarget = Math.max(-1.2, Math.min(1.2, pitchTarget));
      }
    }, { passive: true });

    function endLook(e){
      for(const t of e.changedTouches){
        if(t.identifier !== lookTouchId) continue;
        lookTouchId = null;
      }
    }
    zone.addEventListener('touchend', endLook, { passive: true });
    zone.addEventListener('touchcancel', endLook, { passive: true });
  }

  function setupTouchButtons(){
    const runBtn = document.getElementById('runBtn');
    runBtn.addEventListener('touchstart', e => { running = true; runBtn.classList.add('held'); e.preventDefault(); }, { passive: false });
    runBtn.addEventListener('touchend', e => { running = false; runBtn.classList.remove('held'); }, { passive: true });
    runBtn.addEventListener('touchcancel', e => { running = false; runBtn.classList.remove('held'); }, { passive: true });

    const flashBtn = document.getElementById('flashBtn');
    flashBtn.addEventListener('touchstart', e => { onFlashlightToggle && onFlashlightToggle(); e.preventDefault(); }, { passive: false });
  }

  /* ---------------------------------------------------------
     UPDATE — called once per frame with dt seconds
  --------------------------------------------------------- */
  function update(dt){
    // Smooth look: low-pass filter toward the latest target instead of
    // snapping instantly. Frame-rate independent via exponential decay.
    const lookSmooth = 1 - Math.pow(0.0008, dt);
    yaw += (yawTarget - yaw) * lookSmooth;
    pitch += (pitchTarget - pitch) * lookSmooth;

    camera.rotation.order = 'YXZ';
    camera.rotation.y = yaw;
    camera.rotation.x = pitch;

    let fwd = 0, strafe = 0;
    let isRunning = running;

    if(isTouch){
      fwd = -moveVec.y;
      strafe = moveVec.x;
    } else {
      if(keys['KeyW'] || keys['ArrowUp']) fwd += 1;
      if(keys['KeyS'] || keys['ArrowDown']) fwd -= 1;
      if(keys['KeyD'] || keys['ArrowRight']) strafe += 1;
      if(keys['KeyA'] || keys['ArrowLeft']) strafe -= 1;
      if(keys['ShiftLeft'] || keys['ShiftRight']) isRunning = true;
    }

    const len = Math.hypot(fwd, strafe);
    if(len > 0.001){
      fwd /= Math.max(len, 1);
      strafe /= Math.max(len, 1);
    }

    const targetSpeed = len > 0.001 ? (isRunning ? CONFIG.runSpeed : CONFIG.moveSpeed) : 0;
    // Smooth accel/decel toward target speed for a grounded feel
    // instead of an instant velocity snap.
    const accel = targetSpeed > currentSpeed ? CONFIG.accel : CONFIG.decel;
    currentSpeed += Math.sign(targetSpeed - currentSpeed) * Math.min(Math.abs(targetSpeed - currentSpeed), accel * dt);
    if(Math.abs(targetSpeed - currentSpeed) < 0.001) currentSpeed = targetSpeed;

    const sinY = Math.sin(yaw), cosY = Math.cos(yaw);
    const moveX = (-sinY * fwd + cosY * strafe) * currentSpeed * dt;
    const moveZ = (-cosY * fwd - sinY * strafe) * currentSpeed * dt;

    player.pos.x += moveX;
    player.pos.z += moveZ;

    // Head-bob: amplitude fades in/out with current speed, phase driven
    // by distance traveled so the bob frequency naturally tracks pace.
    const moved = Math.hypot(moveX, moveZ);
    bobDistance += moved;
    const speedFrac = Math.min(1, currentSpeed / CONFIG.runSpeed);
    const targetBob = speedFrac * CONFIG.headBobAmount;
    bobAmount += (targetBob - bobAmount) * Math.min(1, dt * 6);
    const bobY = Math.sin(bobDistance * CONFIG.headBobFrequency) * bobAmount;
    const bobX = Math.cos(bobDistance * CONFIG.headBobFrequency * 0.5) * bobAmount * 0.4;

    player.pos.y = 1.7 + bobY;
    camera.position.set(player.pos.x + bobX, player.pos.y, player.pos.z);

    return { isRunning, speedFrac };
  }

  function getPlayerPos(){ return player.pos; }
  function isTouchDevice(){ return isTouch; }

  return {
    init,
    update,
    requestLock,
    bindClickToLock,
    getPlayerPos,
    isTouchDevice
  };

})();
