package com.company.module.user.controller;

import com.company.core.common.ApiResponse;
import com.company.module.user.entity.UserAccount;
import com.company.module.user.service.UserAccountService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/user-api")
@RequiredArgsConstructor
public class UserAccountController {

    private final UserAccountService userAccountService;

    @GetMapping("/users")
    public ResponseEntity<ApiResponse<List<UserAccount>>> getUsers() {
        return ResponseEntity.ok(ApiResponse.ok(userAccountService.findAll()));
    }

    @GetMapping("/users/{userId}")
    public ResponseEntity<ApiResponse<UserAccount>> getUser(@PathVariable Long userId) {
        return ResponseEntity.ok(ApiResponse.ok(userAccountService.findById(userId)));
    }
}
