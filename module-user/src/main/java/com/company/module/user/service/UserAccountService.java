package com.company.module.user.service;

import com.company.core.exception.BusinessException;
import com.company.module.user.entity.UserAccount;
import com.company.module.user.repository.UserAccountRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

@Service
@RequiredArgsConstructor
public class UserAccountService {

    private final UserAccountRepository userAccountRepository;

    @Transactional(readOnly = true)
    public List<UserAccount> findAll() {
        return userAccountRepository.findAll();
    }

    @Transactional(readOnly = true)
    public UserAccount findById(Long userId) {
        return userAccountRepository.findById(userId)
                .orElseThrow(() -> new BusinessException("USER_NOT_FOUND", "User not found: " + userId, 404));
    }

    @Transactional
    public UserAccount create(UserAccount userAccount) {
        if (userAccountRepository.existsByLoginId(userAccount.getLoginId())) {
            throw new BusinessException("USER_DUPLICATE", "Login ID already exists: " + userAccount.getLoginId());
        }
        return userAccountRepository.save(userAccount);
    }
}
