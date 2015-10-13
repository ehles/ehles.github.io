// make webgl context
var gl = document.createElement('canvas').getContext('webgl');
// set canvas size
gl.canvas.width = window.innerWidth;
gl.canvas.height = window.innerHeight;

// append canavs element
document.body.appendChild(gl.canvas);
// set viewport not redundant
gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
// enable Blend mode.
gl.enable(gl.BLEND);
// set Blend mode.
gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
var frameCount = 0;

// create array
var verts = [];
// set values
var nx = ny = nz = 19;
// inside for loop, push vector value to each elment in the array
for(var z = 0; z < nz; z++) {
  for(var y = 0; y < ny; y++) {
    for(var x = 0; x < nx; x++) {
      verts.push(x / (nx - 1) * 2 -1, y / (ny - 1) * 2 -1, z / (nz - 1) * 2 -1);
    }
  }
}

// create vertex buffer
var vb = gl.createBuffer();
// bind buffer to gl context
gl.bindBuffer(gl.ARRAY_BUFFER, vb);
// after binding, set buffer data
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);

// init shader including createshader, load, createprogram, attach, use...
// create shader
var vs = gl.createShader(gl.VERTEX_SHADER);
// set shader source
gl.shaderSource(vs, document.getElementById('vs').text);
// compile glsl
gl.compileShader(vs);

// methods to init fragment shader.. same with initializing vertex shaer
var fs = gl.createShader(gl.FRAGMENT_SHADER);
// set shader source
gl.shaderSource(fs, document.getElementById('fs').text);
// compile glsl
gl.compileShader(fs);


// test info
console.log(gl.getShaderInfoLog(fs));
console.log(gl.getShaderInfoLog(vs));

// create ~ use program
var prog = gl.createProgram();
gl.attachShader(prog, vs);
gl.attachShader(prog, fs);
gl.linkProgram(prog);

// attribute thing
var eachPos = gl.getAttribLocation(prog, "eachPos");
gl.enableVertexAttribArray(eachPos);
gl.vertexAttribPointer(eachPos, 3, gl.FLOAT, false, 0, 0);

// declare variable to communicate with glsl
var transitionTime = gl.getUniformLocation(prog, "transitionTime");
// use program
gl.useProgram(prog);

var draw = function() {
  var time = frameCount / 60;
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  // set unifrom to glsl
  gl.uniform1f(transitionTime, time);
  // draw
  gl.drawArrays(gl.LINE_LOOP, 0, verts.length / 3);
  frameCount++;
};

var loop = function() {
draw();
requestAnimationFrame(loop);
};

loop();